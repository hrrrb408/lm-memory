// locomo-smoke-lib.mjs — smoke 用确定性模型桩（不联网；judge/reader 行为可控）。
// 只实现 runner 需要的四个导出，用于验证控制流（不入库为评测结果）。
export const ANSWER_PROMPT_V2 = (timeline, snippets, question) => `ANSWER|${question}`;
export const judgePrompt = (profile, question, gold, hypothesis) => `JUDGE|${hypothesis}`;
export async function glm(messages) {
  const prompt = String(messages?.[0]?.content ?? "");
  if (prompt.startsWith("ANSWER|")) {
    const q = prompt.slice(7);
    if (q.startsWith("ADV-ABSTAIN")) return "No information available."; // 正确弃答
    if (q.startsWith("ADV-INDUCED")) return "The plausible distractor says it is true."; // 被诱导作答
    return "The answer is test."; // 常规题正确
  }
  if (prompt.startsWith("JUDGE|")) return prompt.includes("The answer is test") ? "yes" : "no";
  return "yes";
}
export async function summarizeSessionPack(pack) { return ["摘要：合成测试会话"]; }
