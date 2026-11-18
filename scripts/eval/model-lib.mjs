// Portable evaluation transport. No automatic credential-file discovery.
// Prompt templates below originate from the project's historical lm-bench harness.
export const GLM_MODEL = process.env.BENCH_LLM;
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const usage = {requests:0,cache_hits:0,prompt_tokens:0,completion_tokens:0};
export async function glm(messages, {maxTokens=300, temperature=0}={}) {
  const base=process.env.BENCH_BASE_URL, key=process.env.BENCH_API_KEY;
  if (!base || !key || !GLM_MODEL) throw new Error('Set BENCH_BASE_URL, BENCH_API_KEY, BENCH_LLM explicitly');
  const body={model:GLM_MODEL,messages,max_tokens:maxTokens,temperature,thinking:{type:'disabled'}};
  const hash=createHash('sha256').update(JSON.stringify([base,body])).digest('hex');
  const cache=process.env.BENCH_CACHE_DIR;
  const file=cache && path.join(cache,hash+'.json');
  if(file && fs.existsSync(file)){usage.cache_hits++;return JSON.parse(fs.readFileSync(file,'utf8')).content;}
  for(let attempt=0;attempt<3;attempt++) {
    const r=await fetch(base.replace(/\/$/,'')+'/chat/completions',{
      method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)});
    if(!r.ok){if((r.status===429||r.status>=500)&&attempt<2){await new Promise(r=>setTimeout(r,2000*(attempt+1)));continue;}throw new Error('Model HTTP '+r.status);}
    const response=await r.json(),c=response.choices?.[0];
    usage.requests++;usage.prompt_tokens+=response.usage?.prompt_tokens??0;usage.completion_tokens+=response.usage?.completion_tokens??0;
    if(process.env.BENCH_USAGE_LOG)fs.appendFileSync(process.env.BENCH_USAGE_LOG,JSON.stringify({hash,model:response.model??GLM_MODEL,usage:response.usage,finish_reason:c?.finish_reason,at:new Date().toISOString()})+'\n',{mode:0o600});
    if(c?.finish_reason==='length') {
      if(maxTokens<2048) return glm(messages,{maxTokens:Math.min(maxTokens*4,2048),temperature});
      throw new Error('Model output truncated at maximum budget');
    }
    if(typeof c?.message?.content!=='string') throw new Error('Invalid model response');
    const record={model:response.model??GLM_MODEL,content:c.message.content.trim(),usage:response.usage,at:new Date().toISOString()};
    if(file){fs.mkdirSync(cache,{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(record),{mode:0o600});fs.renameSync(tmp,file);}
    return record.content;
  }
}
// LongMemEval 官方判分模板（逐字取自 src/evaluation/evaluate_qa.py，gpt-4o → glm 判分）
export function judgePrompt(task, question, answer, response, abstention = false) {
  if (abstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (task === "temporal-reasoning") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "knowledge-update") {
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  if (task === "single-session-preference") {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

export const ANSWER_PROMPT = (snippets, question) => `You are a chat assistant with long-term memory of past conversations with the user. Answer the question using ONLY the memory snippets below (each prefixed with its date). If the snippets do not contain enough information, respond exactly: I don't have enough information. Be concise (one short sentence where possible).

Memory snippets:
${snippets}

Question: ${question}`;

// ===== v2 读时上下文工程（弱项优化）=====

// 会话摘要卡：把若干 session 打包成一次 glm 调用，产出带日期的一行式摘要（时间线原料）
export async function summarizeSessionPack(pack) {
  // pack: [{ sid, date, text }]（text 已截断）
  const body = pack.map((p) => `[${p.sid} ${p.date}]\n${p.text}`).join("\n\n");
  const out = await glm([{
    role: "user",
    content: `Summarize each conversation session below in 1-2 sentences, keeping facts, preferences, events, names, numbers and dates mentioned (especially anything updated or changed). Output one line per session, exactly in the format "[sID date] summary". No other text.\n\nSessions:\n${body}`,
  }], { maxTokens: 900 });
  return out.split("\n").filter((l) => /^\[s\d+/.test(l.trim())).map((l) => l.trim());
}

// ===== v3 两弱项攻坚：问题分解（multi-hop）+ 弃答门（adversarial）=====

// 问题分解：把多跳问题拆成可单片段作答的子问题
export async function decompose(question) {
  const out = await glm([{
    role: "user",
    content: `Decompose this question into 1-3 simple sub-questions, each answerable from a single memory snippet of a past conversation. If it is already simple (answerable from one snippet), return it unchanged. Output ONLY a JSON array of strings.\n\nQuestion: ${question}`,
  }], { maxTokens: 200 });
  try {
    const arr = JSON.parse(out.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const qs = arr.filter((q) => typeof q === "string" && q.trim());
    return qs.length ? qs.slice(0, 3) : [question];
  } catch { return [question]; }
}

// 弃答门：问题预设的实体/细节是否真的存在于来源中
export async function gateCheck(timeline, snippets, question) {
  const src = `${timeline}\n${snippets}`.slice(0, 6000);
  const out = await glm([{
    role: "user",
    content: `You are a strict gatekeeper checking whether the SOURCES below directly support answering the QUESTION.

Method: identify the key entities (people, objects, events) and the specific fact the question asks for. Check each against the SOURCES — exact mentions or clear synonyms count; mere associations do NOT.

Rules:
- If the question presupposes an entity or relationship that never appears in the SOURCES, answer NO.
- If the entities appear but the specific asked detail is nowhere stated, answer NO.
- If unsure after careful checking, answer YES (let the answerer decide).

Output exactly one word: YES or NO.

SOURCES:
${src}

QUESTION: ${question}`,
  }], { maxTokens: 24 });
  return !/^\s*no\b/i.test(out.trim());
}

// v4 答题管线：分解 → 多路检索合并 → 自查式作答（弃答决策内化，不硬拦截）
export const ANSWER_PROMPT_V4 = (timeline, snippets, question) => `You are a chat assistant with long-term memory of past conversations. You have TWO sources:

(1) TIMELINE of dated session summaries:
${timeline || "(none)"}

(2) Retrieved memory snippets, each prefixed [date sID]:
${snippets || "(none)"}

Procedure (follow strictly):
1. Identify the specific entities (people, objects, events) and the exact detail the question asks for.
2. Verify each against the sources. Exact mentions or clear synonyms count; mere associations do NOT.
3. If a key entity or the asked detail is absent from BOTH sources, the question is unanswerable — do NOT substitute a related true fact.
4. Otherwise answer from the sources; if snippets conflict, the LATER date wins; for time questions, compute from the dates.

Output exactly two lines:
CHECK: <what you looked for and whether it was found, one short line>
ANSWER: <one short sentence; or exactly: I don't have enough information.>

Question: ${question}`;

export async function answerQuestionV3(call, question, timeline, limit = 8) {
  const subqs = await decompose(question);
  const seen = new Map();
  for (const sq of subqs) {
    const raw = await call("memory_recall", { query: sq, limit });
    let rows = []; try { rows = JSON.parse(raw); } catch {}
    for (const r of rows) if (r.id !== undefined && !seen.has(r.id)) seen.set(r.id, r);
  }
  const rows = [...seen.values()].slice(0, 18);
  const snippets = rows.map((r) => r.content).join("\n");
  const out = await glm([{ role: "user", content: ANSWER_PROMPT_V4(timeline, snippets, question) }], { maxTokens: 320 });
  const m = out.match(/^ANSWER:\s*(.+)$/m);
  const hypothesis = m ? m[1].trim() : out.trim();
  return { rows, hypothesis, subqs, gated: /I don'?t have enough information/i.test(hypothesis) };
}

// 答题提示词 v2：时间线 + 片段双通道；冲突取最新；宁弃答不猜
export const ANSWER_PROMPT_V2 = (timeline, snippets, question) => `You are a chat assistant with long-term memory of past conversations with the user. You have TWO sources:

(1) TIMELINE of dated session summaries (for cross-session joins and chronology):
${timeline || "(none)"}

(2) Retrieved memory snippets, each prefixed [date sID] (for exact details):
${snippets || "(none)"}

Rules:
- Ground every answer in (1) or (2). Never use outside knowledge.
- If snippets conflict, trust the one with the LATER date (the user's latest state wins).
- DATE ANCHORING (critical): when a snippet says "yesterday", "last week", "two days ago", "last Saturday", "last year" etc., anchor it to that snippet's [date sID] prefix and compute the ABSOLUTE date. Example: snippet dated 2023-01-28 saying "yesterday" → answer 2023-01-27; "last week" before a session dated 2023-01-01 → late December 2022. Always convert relative time to absolute dates in your answer.
- If the question asks about a person, detail, or event that never appears in the sources, respond exactly: I don't have enough information. Do NOT guess from related-but-different information, and do NOT substitute a related true fact — absence of the specific answer means abstain.

Question: ${question}`;

export async function answerQuestion(call, question, limit = 10) {
  const raw = await call("memory_recall", { query: question, limit });
  let rows = [];
  try { rows = JSON.parse(raw); } catch { rows = []; }
  const snippets = rows.map((r) => r.content).join("\n");
  const hypothesis = await glm([{ role: "user", content: ANSWER_PROMPT(snippets, question) }], { maxTokens: 220 });
  return { rows, hypothesis };
}
