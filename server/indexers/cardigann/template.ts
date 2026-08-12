/**
 * A deliberately small Go-template-ish evaluator covering the constructs that
 * actually appear in public Cardigann definitions:
 *
 *   {{ .Keywords }}  {{ .Config.sort }}  {{ .Result.title }}  {{ .Query.Season }}
 *   {{ if COND }}A{{ else }}B{{ end }}   (nesting + `else if` supported)
 *   {{ and A B }}  {{ or A B C }}  {{ eq A B }}  {{ ne A B }}  {{ not A }}
 *   {{ range .Categories }}...{{ . }}...{{ end }}
 *   {{ join .Categories "," }}
 *   {{ re_replace .Keywords "pat" "repl" }}
 *
 * Full text/template is way out of scope — anything else throws a
 * TemplateError, which the analyzer turns into supported=false for that def.
 */

export class TemplateError extends Error {}

/** Variables visible to a template. Arrays only appear for .Categories. */
export type TemplateContext = Record<string, string | string[] | null | undefined>;

type Value = string | string[] | null;

interface TextNode {
  kind: "text";
  value: string;
}
interface ExprNode {
  kind: "expr";
  tokens: string[];
}
interface IfNode {
  kind: "if";
  cond: string[];
  then: Node[];
  else: Node[];
}
interface RangeNode {
  kind: "range";
  expr: string[];
  body: Node[];
}
type Node = TextNode | ExprNode | IfNode | RangeNode;

/** Split an action's contents into tokens: idents, quoted strings, parens. */
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) tokens.push(m[0]);
  return tokens;
}

/** Split raw template source into text chunks and `{{ ... }}` actions. */
function lex(src: string): { action: boolean; value: string }[] {
  const parts: { action: boolean; value: string }[] = [];
  const re = /\{\{-?\s*([\s\S]*?)\s*-?\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push({ action: false, value: src.slice(last, m.index) });
    parts.push({ action: true, value: m[1] });
    last = re.lastIndex;
  }
  if (last < src.length) parts.push({ action: false, value: src.slice(last) });
  return parts;
}

/** Recursive-descent parse of the lexed stream into a node tree. */
function parseNodes(
  parts: { action: boolean; value: string }[],
  pos: { i: number },
  insideBlock: boolean
): { nodes: Node[]; terminator: string | null } {
  const nodes: Node[] = [];
  while (pos.i < parts.length) {
    const part = parts[pos.i];
    if (!part.action) {
      nodes.push({ kind: "text", value: part.value });
      pos.i++;
      continue;
    }
    const tokens = tokenize(part.value);
    const head = tokens[0];
    if (head === "end" || head === "else") {
      if (!insideBlock) throw new TemplateError(`unexpected {{ ${head} }}`);
      // Leave the terminator for the caller to consume/inspect.
      return { nodes, terminator: head };
    }
    pos.i++;
    if (head === "if") {
      nodes.push(parseIf(parts, pos, tokens.slice(1)));
    } else if (head === "range") {
      const body = parseNodes(parts, pos, true);
      if (body.terminator !== "end") throw new TemplateError("range without end");
      pos.i++; // consume the end
      nodes.push({ kind: "range", expr: tokens.slice(1), body: body.nodes });
    } else {
      nodes.push({ kind: "expr", tokens });
    }
  }
  if (insideBlock) throw new TemplateError("unterminated block (missing {{ end }})");
  return { nodes, terminator: null };
}

/** Parse the body of an `if`, handling `else` and `else if` chains. */
function parseIf(parts: { action: boolean; value: string }[], pos: { i: number }, cond: string[]): IfNode {
  const thenBranch = parseNodes(parts, pos, true);
  const node: IfNode = { kind: "if", cond, then: thenBranch.nodes, else: [] };
  if (thenBranch.terminator === "end") {
    pos.i++; // consume end
    return node;
  }
  // terminator === "else": is it a bare else or an `else if`?
  const elseTokens = tokenize(parts[pos.i].value);
  pos.i++; // consume the else action
  if (elseTokens.length > 1 && elseTokens[1] === "if") {
    // `else if C` shares our `end`; model it as a nested if in the else branch.
    node.else = [parseIf(parts, pos, elseTokens.slice(2))];
    return node;
  }
  const elseBranch = parseNodes(parts, pos, true);
  if (elseBranch.terminator !== "end") throw new TemplateError("if without end");
  pos.i++; // consume end
  node.else = elseBranch.nodes;
  return node;
}

function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return v !== "";
}

function asString(v: Value): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(",");
  return v;
}

/**
 * Evaluate one expression token stream (the inside of `{{ ... }}` minus
 * if/range keywords). Returns a Value so `or` can pass arrays through.
 */
function evalExpr(tokens: string[], ctx: TemplateContext, rangeItem: string | null): Value {
  const state = { i: 0 };
  const value = parseOperand(tokens, state, ctx, rangeItem);
  // Some upstream definitions carry stray trailing `)` typos (e.g. 1337x);
  // Prowlarr's parser tolerates them, so we do too.
  while (tokens[state.i] === ")") state.i++;
  if (state.i < tokens.length) {
    throw new TemplateError(`unexpected token '${tokens[state.i]}' in template expression`);
  }
  return value;
}

const FUNCTIONS = new Set(["and", "or", "eq", "ne", "not", "join", "re_replace"]);

function parseOperand(
  tokens: string[],
  state: { i: number },
  ctx: TemplateContext,
  rangeItem: string | null
): Value {
  const tok = tokens[state.i];
  if (tok === undefined) throw new TemplateError("empty template expression");
  state.i++;
  if (tok === "(") {
    // Parenthesized sub-expression: gather args like a top-level call.
    const inner = parseCallOrOperand(tokens, state, ctx, rangeItem);
    if (tokens[state.i] !== ")") throw new TemplateError("missing ) in template");
    state.i++;
    return inner;
  }
  if (FUNCTIONS.has(tok)) {
    state.i--;
    return parseCallOrOperand(tokens, state, ctx, rangeItem);
  }
  return atomValue(tok, ctx, rangeItem);
}

/** Parse either a function call with args (greedy until `)`/end) or one atom. */
function parseCallOrOperand(
  tokens: string[],
  state: { i: number },
  ctx: TemplateContext,
  rangeItem: string | null
): Value {
  const tok = tokens[state.i];
  if (tok !== undefined && FUNCTIONS.has(tok)) {
    state.i++;
    const args: Value[] = [];
    // Stopping at any ")" both terminates parenthesized calls and leaves the
    // stray `)` typos some upstream defs contain for evalExpr to skip.
    while (state.i < tokens.length && tokens[state.i] !== ")") {
      args.push(parseOperand(tokens, state, ctx, rangeItem));
    }
    return applyFunction(tok, args);
  }
  return parseOperand(tokens, state, ctx, rangeItem);
}

function applyFunction(name: string, args: Value[]): Value {
  switch (name) {
    case "and": {
      // Go's `and` returns the first falsy arg, else the last arg.
      let last: Value = null;
      for (const a of args) {
        if (!truthy(a)) return a;
        last = a;
      }
      return last;
    }
    case "or": {
      for (const a of args) if (truthy(a)) return a;
      return args.length ? args[args.length - 1] : null;
    }
    case "eq":
      return asString(args[0]) === asString(args[1]) ? "True" : null;
    case "ne":
      return asString(args[0]) !== asString(args[1]) ? "True" : null;
    case "not":
      return truthy(args[0] ?? null) ? null : "True";
    case "join": {
      const list = args[0];
      const sep = asString(args[1] ?? ",");
      return Array.isArray(list) ? list.join(sep) : asString(list);
    }
    case "re_replace": {
      const [input, pattern, repl] = args;
      try {
        return asString(input).replace(toJsRegExp(asString(pattern), "g"), asString(repl));
      } catch {
        throw new TemplateError(`re_replace: bad pattern ${asString(pattern)}`);
      }
    }
    default:
      throw new TemplateError(`unsupported template function '${name}'`);
  }
}

/**
 * Unquote a template string literal. JSON.parse is too strict: Go templates
 * carry regex literals like "\d+" or "\/" that JSON rejects outright, so
 * unknown escapes keep the escaped character verbatim.
 */
function unquote(tok: string): string {
  const body = tok.slice(1, -1);
  return body.replace(/\\(.)/g, (_whole, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        // Regex escapes (\d, \s, \/, …) must survive intact for re_replace.
        return `\\${ch}`;
    }
  });
}

/** Resolve a single token: literal, `.` (range item), or dotted variable path. */
function atomValue(tok: string, ctx: TemplateContext, rangeItem: string | null): Value {
  if (tok.startsWith('"')) return unquote(tok);
  if (/^-?\d+(\.\d+)?$/.test(tok)) return tok;
  if (tok === ".") {
    if (rangeItem === null) throw new TemplateError("{{ . }} outside range");
    return rangeItem;
  }
  if (tok.startsWith(".")) {
    // Variables are stored flat under their dotted path (".Config.sort").
    const v = ctx[tok];
    return v === undefined ? null : v;
  }
  throw new TemplateError(`unsupported template token '${tok}'`);
}

/**
 * Translate a Go regex to a JS RegExp. Go supports inline flags like `(?i)`
 * which JS lacks — hoist leading ones into RegExp flags (mid-pattern inline
 * flags are rare in definitions and simply dropped).
 */
export function toJsRegExp(pattern: string, extraFlags = ""): RegExp {
  let flags = extraFlags;
  let p = pattern;
  const m = /^\(\?([ims]+)\)/.exec(p);
  if (m) {
    p = p.slice(m[0].length);
    for (const f of m[1]) if (f !== "m" && !flags.includes(f)) flags += f;
    if (m[1].includes("m") && !flags.includes("m")) flags += "m";
  }
  return new RegExp(p, flags);
}

function render(nodes: Node[], ctx: TemplateContext, rangeItem: string | null, escape: (s: string) => string): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "expr":
        out += escape(asString(evalExpr(node.tokens, ctx, rangeItem)));
        break;
      case "if":
        out += render(
          truthy(evalExpr(node.cond, ctx, rangeItem)) ? node.then : node.else,
          ctx,
          rangeItem,
          escape
        );
        break;
      case "range": {
        const list = evalExpr(node.expr, ctx, rangeItem);
        const items = Array.isArray(list) ? list : truthy(list) ? [asString(list)] : [];
        for (const item of items) out += render(node.body, ctx, item, escape);
        break;
      }
    }
  }
  return out;
}

export interface EvalOptions {
  /**
   * Applied to every substituted VALUE (not literal text). Used to URL-encode
   * keywords when a template builds a URL path; identity elsewhere.
   */
  escape?: (s: string) => string;
}

/** Does this string contain any template action at all? Cheap fast-path. */
export function hasTemplate(src: string): boolean {
  return src.includes("{{");
}

/** Evaluate a template string against a context. Throws TemplateError. */
export function evalTemplate(src: string, ctx: TemplateContext, options?: EvalOptions): string {
  if (!hasTemplate(src)) return src;
  const parts = lex(src);
  const { nodes } = parseNodes(parts, { i: 0 }, false);
  return render(nodes, ctx, null, options?.escape ?? ((s) => s));
}

/**
 * Parse-and-evaluate with a dummy context to detect unsupported constructs at
 * analysis time (bad nesting, unknown functions). Unknown variables are fine —
 * they resolve to "" — so this only trips on structural problems.
 */
export function validateTemplate(src: string): void {
  if (!hasTemplate(src)) return;
  const parts = lex(src);
  const { nodes } = parseNodes(parts, { i: 0 }, false);
  render(nodes, {}, null, (s) => s);
}
