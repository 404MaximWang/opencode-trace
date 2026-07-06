/**
 * OpenCode server plugin which captures raw LLM HTTP payloads to a configured JSONL file.
 *
 * Each trace is a jsonl file with one JSON object per line.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

const root = process.env.TRACE_DIR
const filename = process.env.TRACE_FILENAME

/** Mutable global state: maps OpenCode session ids to the html logfile path for that session. */
const files = new Map<string, string>()

/** Mutable global state: maps `session\nmethod\nurl\n_kind\nmeta|real` to the previous raw body used as the delta base. */
const prevs = new Map<string, object>()

/** Mutable global state: maps OpenCode session ids to the next per-session fetch sequence number. */
const ids = new Map<string, number>()

/** Mutable global state: tracks files already initialized by this module instance. */
const initialized = new Set<string>()

/** Mutable module state: the unpatched global fetch for this module instance, assigned inside `server()`. */
let orig: typeof globalThis.fetch | undefined

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/**
 * Given a parsed LLM request body, returns the first user prompt text if one is present, e.g.
 * {input:[{role:"user",content:[{type:"input_text",text:"why is the sky blue?"}]}]}
 * ==> "why is the sky blue?"
 */
function extractPromptFromRequestBody(v: Record<string, unknown>): string | undefined {
  const usable = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim()
    return trimmed && trimmed !== "Generate a title for this conversation:" ? trimmed : undefined
  }
  const text = (part: unknown): string | undefined => {
    if (typeof part === "string") return usable(part)
    if (!isRecord(part)) return
    if (typeof part.text === "string") return usable(part.text)
    if (typeof part.input_text === "string") return usable(part.input_text)
    return undefined
  }
  const content = (v: unknown): string | undefined => {
    if (typeof v === "string") return usable(v)
    if (!Array.isArray(v)) return undefined
    for (const part of v) {
      const found = text(part)
      if (found) return found
    }
    return undefined
  }
  const first = (list: unknown, key: "input" | "messages"): string | undefined => {
    if (!Array.isArray(list)) return undefined
    for (const item of list) {
      if (!isRecord(item)) continue
      if (item.role !== "user") continue
      const found = content(item.content) ?? (key === "input" ? text(item) : undefined)
      if (found) return found
    }
    return undefined
  }
  return first(v.input, "input") ?? first(v.messages, "messages") ?? (typeof v.prompt === "string" ? v.prompt : undefined)
}

/**
 * Appends one row to the session logfile. If logging fails, then skips silently.
 */
function writeNoThrow(id: string, _name: string, row: Record<string, unknown>): void {
  try {
    if (root === undefined || filename === undefined) return
    if (!path.isAbsolute(root)) return
    if (filename === "" || filename.includes("/") || filename.includes("\\")) return
    const prev = files.get(id)
    const file = prev ?? path.join(root, `${filename}.jsonl`)
    mkdirSync(root, { recursive: true })
    if (!initialized.has(file)) {
      writeFileSync(file, "")
      initialized.add(file)
    }
    files.set(id, file)
    appendFileSync(file, `${JSON.stringify(row)}\n`)
  } catch {
    // Intentionally swallow tracing I/O failures so plugin logging can't crash OpenCode.
  }
}

/**
 * Given two json values, returns a bool for whether they are identical, plus a
 * (lossy) representation of the difference intended for humans to read, which
 * still roughly captures the shape even of unchanged objects.
 *
 * The representation always has the same type as `next`.
 *
 * For changed lists, the representation is either the full new list, or, when shorter,
 * `[changedRecords, '...', additions, '---', removals]`.
 *
 * For dicts, removed keys appear as `-k: null`, added keys as `+k: v`, and changed keys as
 * `*k: v`. If a changed dict field is itself a compact list diff, that is rendered as
 * `k+: [...]` and `k-: [...]` for readability.
 */
function delta(prev: unknown, next: unknown): [unknown, boolean] {
  const hash = (v: unknown): string => {
    const sort = (v: unknown): unknown => {
      if (isArray(v)) {
        return v.map(sort);
      }
      if (!v || typeof v !== 'object') {
        return v;
      }
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map(k => [k, sort((v as Record<string, unknown>)[k])]),
      );
    };
    return createHash("blake2b512").update(JSON.stringify(sort(v))).digest("hex")
  };
  if (isRecord(prev) && isRecord(next)) {
    // RECORDS: Overall resulting record is just {"[repeat]":"[repeat]"} if it's unchanged. This is the only case
    // where the result has a different structure from the input (well it's still a record, just with keys lost).
    // Otherwise the result is a record with
    // - `{"-k":null}` for keys that were in prev but absent in next
    // - `{"+k":v}` for keys that were absent in prev and present in next
    // - `{"k":v}` for keys present in both, and v is unchanged in prev and next, and fairly short
    //    - `{"k":["..."]}` for keys present in both, and v is an unchanged longish array
    //    - `{"k":{"[unchanged]":"[unchanged]"}}` for keys present in both, and v is an unchanged longish object
    //    - `{"k":"[unchanged]"}` for keys present in both, and v is an unchanged longish string
    //    - `{"k":v}` for keys present in both, and v is an unchanged longish anything else
    // - `{"*k":v}` for keys present in both, and v is a changed non-record non-array
    // - `{"*k":delta}` for keys present in both, and v is a changed record
    // - `{"*k":[...v]}` for keys present in both, and v is a changed array best represented as new array, or changes followed by remainder, or changes followed by adds+dels
    // - `{"k+":[...adds], "k-":[...dels]}` for keys present in both, and v is a changed array best represented just with adds and dels (skip either if absent)
    let isSame = true;
    const out: Record<string, unknown> = {};
    const prevKeys = new Set(Object.keys(prev));
    const nextKeys = new Set(Object.keys(next));
    for (const k of [...prevKeys].filter(k => !nextKeys.has(k)).sort()) {
      out[`-${k}`] = null;
      isSame = false;
    }
    for (const k of [...nextKeys].filter(k => !prevKeys.has(k)).sort()) {
      out[`+${k}`] = next[k];
      isSame = false;
    }
    for (const k of [...prevKeys].filter(k => nextKeys.has(k)).sort()) {
      const [sub, same] = delta(prev[k], next[k]);
      if (same) {
        const raw = JSON.stringify(next[k]) ?? '';
        out[k] =
          raw.length < 128
            ? next[k]
            : isArray(next[k])
              ? ['...']
              : isRecord(next[k])
                ? {'[unchanged]': '[unchanged]'}
                : typeof next[k] === 'string'
                  ? '[unchanged]'
                  : next[k];
        continue;
      }
      isSame = false;
      if (!isArray(sub) || (sub[0] !== '...' && sub[0] !== '---')) {
        out[`*${k}`] = sub;
        continue;
      }
      const cut = sub.findIndex(item => item === '---');
      const cut2 = cut === -1 ? undefined : cut;
      const add = cut2 === 0 ? [] : cut2 == null ? sub.slice(1) : sub.slice(1, cut2);
      const del = cut2 == null ? [] : sub.slice(cut2 + 1);
      if (del.length > 0) {
        out[`${k}-`] = del;
      }
      if (add.length > 0) {
        out[`${k}+`] = add;
      }
    }
    return isSame ? [{'[repeat]': '[repeat]'}, true] : [out, false];
  } else if (isArray(prev) && isArray(next)) {
    // ARRAYS: Overall resulting array is `[...changedRecordsPrefix, "...", ...adds, "---", ...dels]`
    // or, if more compact, `[...changedRecordsPrefix, ...nextRemainder]`
    // - The adds/dels themselves have a greedy algorithm: in prev=[c,d,e,f] next=[d,e,c] then we greedily match c, hence adds=[d,e] and dels=[d,e,f]
    // - The changedRecordsPrefix deliberately skips identical record elements, just like identical non-array elements get skipped too
    const changedRecordsPrefix: Array<unknown> = [];
    let shownEllipsis = false;
    let i = 0;
    for (; i < prev.length && i < next.length; i++) {
      if (!isRecord(prev[i]) || !isRecord(next[i])) {
        break;
      }
      const [elDif, elIsSame] = delta(prev[i], next[i]);
      if (elIsSame && !shownEllipsis) {
        changedRecordsPrefix.push('...*');
        shownEllipsis = true;
      }
      if (!elIsSame) {
        changedRecordsPrefix.push(elDif);
      }
    }
    const left: Array<readonly [unknown, string]> = prev.slice(i).map(v => [v, hash(v)] as const);
    let right: Array<readonly [unknown, string]> = next.slice(i).map(v => [v, hash(v)] as const);
    const add: unknown[] = [];
    const del: unknown[] = [];
    for (const [value, sig] of left) {
      const ix = right.findIndex(item => item[1] === sig);
      if (ix === -1) {
        del.push(value);
        continue;
      }
      add.push(...right.slice(0, ix).map(item => item[0]));
      right = right.slice(ix + 1);
    }
    add.push(...right.map(item => item[0]));
    if (add.length === 0 && del.length === 0) {
      return [
        [...changedRecordsPrefix, ...next.slice(i)],
        changedRecordsPrefix.length === 0 || (changedRecordsPrefix.length === 1 && shownEllipsis),
      ];
    }
    const additionalEllipsis = shownEllipsis ? [] : ['...'];
    if (add.length + del.length < next.length - i) {
      return del.length === 0
        ? [[...changedRecordsPrefix, ...additionalEllipsis, ...add], false]
        : add.length === 0
          ? [[...changedRecordsPrefix, '---', ...del], false]
          : [[...changedRecordsPrefix, ...additionalEllipsis, ...add, '---', ...del], false];
    }
    return [[...changedRecordsPrefix, ...next.slice(i)], false];
  } else {
    // PRIMITIVES: Overall resulting primitive is just `next`, the new value itself.
    return [next, prev === next];
  }
}

/** Given two objects, returns their shallow merge, else just returns the right-hand side. */
function merge(a: unknown, b: unknown): unknown {
  if (!isRecord(a) || !isRecord(b)) return b
  return { ...a, ...b }
}

/**
 * Given an SSE response body, returns parsed `{event?, data}` blocks.
 * Returns undefined if the body is not parseable SSE json.
 */
function events(text: string): Array<{ event: string | undefined; data: unknown }> | undefined {
  const out: Array<{ event: string | undefined; data: unknown }> = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let name: string | undefined
    const data = block
      .split(/\r?\n/)
      .flatMap((line) => {
        if (line.startsWith("event:")) {
          name = line.slice(6).trim()
          return []
        }
        if (line.startsWith("data:")) return [line.slice(5).trimStart()]
        return []
      })
      .join("\n")
    if (!data || data === "[DONE]") continue
    try {
      out.push({ event: name, data: JSON.parse(data) as unknown })
    } catch {
      return
    }
  }
  return out.length > 0 ? out : undefined
}

/** Given parsed OpenAI `/responses` SSE blocks, reconstructs the final response object. */
function openaiResponses(list: Array<{ data: unknown }>): Record<string, unknown> {
  let base: Record<string, unknown> = { object: "response" }
  const ids: string[] = []
  const items = new Map<string, Record<string, unknown>>()
  const sums = new Map<string, string>()
  for (const row of list) {
    if (!isRecord(row.data) || typeof row.data.type !== "string") continue
    if (isRecord(row.data.response)) base = merge(base, row.data.response) as Record<string, unknown>
    if (row.data.type === "response.output_item.added" && isRecord(row.data.item) && typeof row.data.item.id === "string") {
      const id = row.data.item.id
      const item = { ...row.data.item }
      if (item.type === "message") item.content = (items.get(id)?.content as unknown[]) ?? []
      if (!ids.includes(id)) ids.push(id)
      items.set(id, item)
      continue
    }
    if (row.data.type === "response.output_text.delta" && typeof row.data.item_id === "string") {
      const prev = items.get(row.data.item_id) ?? { id: row.data.item_id, type: "message", role: "assistant", content: [] }
      const content: unknown[] = Array.isArray(prev.content) ? [...(prev.content as unknown[])] : []
      const last = content[content.length - 1]
      if (isRecord(last) && last.type === "output_text" && typeof last.text === "string") {
        last.text += typeof row.data.delta === "string" ? row.data.delta : ""
      } else {
        content.push({ type: "output_text", text: typeof row.data.delta === "string" ? row.data.delta : "" })
      }
      items.set(row.data.item_id, { ...prev, content })
      if (!ids.includes(row.data.item_id)) ids.push(row.data.item_id)
      continue
    }
    if (row.data.type === "response.function_call_arguments.delta" && typeof row.data.item_id === "string") {
      const prev = items.get(row.data.item_id) ?? { id: row.data.item_id, type: "function_call", arguments: "" }
      items.set(row.data.item_id, {
        ...prev,
        arguments: `${typeof prev.arguments === "string" ? prev.arguments : ""}${typeof row.data.delta === "string" ? row.data.delta : ""}`,
      })
      if (!ids.includes(row.data.item_id)) ids.push(row.data.item_id)
      continue
    }
    if (row.data.type === "response.function_call_arguments.done" && typeof row.data.item_id === "string") {
      const prev = items.get(row.data.item_id) ?? { id: row.data.item_id, type: "function_call" }
      items.set(row.data.item_id, {
        ...prev,
        arguments: typeof row.data.arguments === "string" ? row.data.arguments : prev.arguments,
      })
      if (!ids.includes(row.data.item_id)) ids.push(row.data.item_id)
      continue
    }
    if (row.data.type === "response.reasoning_summary_text.delta" && typeof row.data.item_id === "string") {
      sums.set(row.data.item_id, `${sums.get(row.data.item_id) ?? ""}${typeof row.data.delta === "string" ? row.data.delta : ""}`)
      continue
    }
    if (row.data.type === "response.output_item.done" && isRecord(row.data.item) && typeof row.data.item.id === "string") {
      const prev = items.get(row.data.item.id) ?? {}
      const next = { ...prev, ...row.data.item }
      if (Array.isArray(prev.content) && !Array.isArray(next.content)) next.content = prev.content
      if (typeof prev.arguments === "string" && typeof next.arguments !== "string") next.arguments = prev.arguments
      items.set(row.data.item.id, next)
      if (!ids.includes(row.data.item.id)) ids.push(row.data.item.id)
    }
  }
  const output = ids.map((id) => {
    const item = { ...(items.get(id) ?? { id }) }
    if (item.type === "reasoning" && sums.has(id)) item.summary = [{ type: "summary_text", text: sums.get(id) }]
    return item
  })
  return { ...base, output }
}

/** Given parsed OpenAI chat-completions SSE blocks, reconstructs the final completion json. */
function openaiChat(list: Array<{ data: unknown }>): Record<string, unknown> {
  const choices = new Map<number, Record<string, unknown>>()
  let id = ""
  let model = ""
  let created = 0
  let usage: unknown
  for (const row of list) {
    if (!isRecord(row.data)) continue
    if (typeof row.data.id === "string") id = row.data.id
    if (typeof row.data.model === "string") model = row.data.model
    if (typeof row.data.created === "number") created = row.data.created
    if (isRecord(row.data.usage)) usage = row.data.usage
    if (!Array.isArray(row.data.choices)) continue
    for (const part of row.data.choices) {
      if (!isRecord(part)) continue
      const ix = typeof part.index === "number" ? part.index : 0
      const prev = choices.get(ix) ?? { index: ix, message: { role: "assistant" }, finish_reason: null }
      const msg: Record<string, unknown> = isRecord(prev.message) ? { ...prev.message } : { role: "assistant" }
      if (isRecord(part.delta)) {
        if (typeof part.delta.role === "string") msg.role = part.delta.role
        if (typeof part.delta.content === "string") msg.content = `${typeof msg.content === "string" ? msg.content : ""}${part.delta.content}`
        if (typeof part.delta.reasoning_content === "string") {
          msg.reasoning_content = `${typeof msg.reasoning_content === "string" ? msg.reasoning_content : ""}${part.delta.reasoning_content}`
        }
        if (Array.isArray(part.delta.tool_calls)) {
          const calls: unknown[] = Array.isArray(msg.tool_calls) ? [...(msg.tool_calls as unknown[])] : []
          for (const call of part.delta.tool_calls) {
            if (!isRecord(call)) continue
            const jx = typeof call.index === "number" ? call.index : calls.length
            const prevCall = isRecord(calls[jx])
              ? { ...calls[jx] }
              : { index: jx, id: call.id, type: call.type ?? "function", function: { name: "", arguments: "" } }
            const fn = isRecord(prevCall.function) ? { ...prevCall.function } : { name: "", arguments: "" }
            if (isRecord(call.function) && typeof call.function.name === "string") fn.name = call.function.name
            if (isRecord(call.function) && typeof call.function.arguments === "string") {
              fn.arguments = `${typeof fn.arguments === "string" ? fn.arguments : ""}${call.function.arguments}`
            }
            calls[jx] = { ...prevCall, ...call, function: fn }
          }
          msg.tool_calls = calls
        }
      }
      choices.set(ix, {
        ...prev,
        message: msg,
        finish_reason: part.finish_reason ?? prev.finish_reason ?? null,
      })
    }
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [...choices.values()].sort((a, b) => Number(a.index) - Number(b.index)),
    ...(usage ? { usage } : {}),
  }
}

/** Given parsed Anthropic SSE blocks, reconstructs the final message json. */
function anthropic(list: Array<{ data: unknown }>): Record<string, unknown> {
  let base: Record<string, unknown> = { type: "message", role: "assistant" }
  const blocks = new Map<number, Record<string, unknown>>()
  const json = new Map<number, string>()
  for (const row of list) {
    if (!isRecord(row.data) || typeof row.data.type !== "string") continue
    if (row.data.type === "message_start" && isRecord(row.data.message)) {
      base = { ...base, ...row.data.message }
      continue
    }
    if (row.data.type === "content_block_start" && typeof row.data.index === "number" && isRecord(row.data.content_block)) {
      blocks.set(row.data.index, { ...row.data.content_block })
      continue
    }
    if (row.data.type === "content_block_delta" && typeof row.data.index === "number" && isRecord(row.data.delta)) {
      const prev = blocks.get(row.data.index) ?? { type: "text", text: "" }
      if (row.data.delta.type === "text_delta") blocks.set(row.data.index, { ...prev, text: `${typeof prev.text === "string" ? prev.text : ""}${typeof row.data.delta.text === "string" ? row.data.delta.text : ""}` })
      if (row.data.delta.type === "input_json_delta") json.set(row.data.index, `${json.get(row.data.index) ?? ""}${typeof row.data.delta.partial_json === "string" ? row.data.delta.partial_json : ""}`)
      continue
    }
    if (row.data.type === "message_delta") {
      if (isRecord(row.data.delta)) base = { ...base, ...row.data.delta }
      if (isRecord(row.data.usage)) base.usage = merge(base.usage, row.data.usage)
      continue
    }
    if (isRecord(row.data.usage)) base.usage = merge(base.usage, row.data.usage)
  }
  const content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ix, block]) => {
      if (block.type !== "tool_use" || !json.has(ix)) return block
      const raw = json.get(ix) ?? ""
      try {
        return { ...block, input: JSON.parse(raw) as unknown }
      } catch {
        return { ...block, input: raw }
      }
    })
  return { ...base, content }
}

/**
 * Given a raw response body and url, returns the final json to log.
 * Plain json is returned directly; known SSE formats are consolidated; failures become `{_body}`.
 */
function responseAsJson(text: string, url: string): Record<string, unknown> {
  try {
    const body = JSON.parse(text) as unknown
    return isRecord(body) ? body : { _body: text }
  } catch {
    const list = events(text)
    if (!list) return { _body: text }
    const path = ((): string => {
      try {
        return new URL(url).pathname
      } catch {
        return url
      }
    })()
    const first = list[0]?.data
    if (path.endsWith("/responses") || (isRecord(first) && typeof first.type === "string" && first.type.startsWith("response."))) {
      return openaiResponses(list)
    }
    if (path.endsWith("/chat/completions") || (isRecord(first) && first.object === "chat.completion.chunk")) {
      return openaiChat(list)
    }
    if (path.endsWith("/messages") || (isRecord(first) && typeof first.type === "string" && (first.type === "message_start" || first.type === "content_block_start"))) {
      return anthropic(list)
    }
    return { _body: text }
  }
}

/**
 * Intercepts matching OpenCode LLM fetches and logs request/response rows.
 * Side effects: mutates `prevs`, mutates `ids`, and writes logs to disk.
 */
async function tracedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  const now = (): string => new Date().toISOString()
  const error = (err: unknown): { _error: string; _stack?: string } =>
    err instanceof Error
      ? err.stack === undefined
        ? { _error: err.message }
        : { _error: err.message, _stack: err.stack }
      : { _error: String(err) }

  const req = new Request(input, init)
  const session = req.headers.get("x-opencode-session") ?? req.headers.get("x-session-affinity") ?? req.headers.get("session_id") ?? undefined;
  if (session === undefined) return orig!(req);

  const text = await req.clone().text().catch(() => "")
  const raw = ((): Record<string, unknown> => {
    try {
      const body = JSON.parse(text) as unknown
      return isRecord(body) ? body : { _body: text }
    } catch {
      return { _body: text }
    }
  })()
  const title = isRecord(raw) && typeof raw._body !== "string" ? extractPromptFromRequestBody(raw) : undefined
  const purpose = isRecord(raw) && Array.isArray(raw.tools) && raw.tools.length > 0 ? '' : '[meta]';
  // The purpose field is "[meta]" for LLM requests that appear to be not part of the conversation, e.g. "generate a title".
  // I tried a bunch of heuristics, and this one "no tools" was the one that worked best across a variety of models.
  // We calculate it here based on the request, and store it on both request and response, since otherwise
  // there are no reliable indicators on the response jsonl for our viewer to key off.
  const seq = (ids.get(session) ?? 0) + 1
  ids.set(session, seq)
  const common = { _id: seq, _purpose: purpose, _url: req.url }
  const name = (title ?? session ?? '')
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .join(" ")
    .slice(0, 50)
    .trim() || "session";
  const requestKey = `${session}\n${req.method}\n${req.url}\nrequest\n${purpose}`
  const requestNext = raw as object
  const [requestRow] = delta(prevs.get(requestKey), requestNext)
  prevs.set(requestKey, requestNext)
  writeNoThrow(session, name, {
    ...(requestRow as Record<string, unknown>),
    ...common,
    _kind: "request",
    _ts: now(),
  })

  const res = await orig!(req).catch((err) => {
    writeNoThrow(session, name, {
      ...common,
      _kind: "error",
      _ts: now(),
      ...error(err),
    })
    throw err
  });
  // We'll register background processing of the response, once it comes. But return 'res' immediately.
  void res
    .clone()
    .text()
    .then((body) => {
      const json = responseAsJson(body, req.url)
      const detail = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string"
        ? json.error.message
        : isRecord(json) && typeof json.error === "string"
          ? json.error
          : `${res.status} ${res.statusText}`
      const responseNext = (!res.ok
        ? { ...json, _status: res.status, _status_text: res.statusText, _error: detail }
        : json) as object
      const responseKey = `${session}\n${req.method}\n${req.url}\nresponse\n${purpose}`
      const [responseRow] = delta(prevs.get(responseKey), responseNext)
      prevs.set(responseKey, responseNext)
      writeNoThrow(session, name, {
        ...(responseRow as Record<string, unknown>),
        ...common,
        _kind: "response",
        _ts: now(),
      })
    })
    .catch((err) => {
      writeNoThrow(session, name, {
        ...common,
        _kind: "error",
        _ts: now(),
        ...error(err),
      })
    })
  return res
}

/* Plugin model:
 * - This module is loaded with dynamic import() when plugin state is initialized for an instance/directory.
 *   The module import is normally cached, so our top-level state like `orig` survives repeated hook initialization
 * - Opencode calls `default.server()` when it initializes this plugin's server hooks for that instance.
 *   This can happen more than once per process across instance reload/dispose, which is why our fetch()
 *   patch is guarded even though the module itself is loaded only once.
 * - Opencode v1.3 has a single unified process for both TUI and server, so its plugin entrypoint `default` is just a function.
 * - Opencode v1.4 has two separate entrypoints, `default.tui()` and `default.server()`
 */
const main: (() => Promise<object>) & {id?: unknown, server?: unknown} = async () => {
  if (!orig) {
    orig = globalThis.fetch.bind(globalThis);
    globalThis.fetch = tracedFetch;
  }
  return {};
};

const entrypoint = main; // opencode v1.3 expects default export to be a function
entrypoint.id = "ljw1004.opencode-trace";
entrypoint.server = main; // opencode v1.4 expects default export to be an object, with server() being what executes
export default entrypoint;
