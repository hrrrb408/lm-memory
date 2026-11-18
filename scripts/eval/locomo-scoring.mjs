// Official cat5 markers plus the exact abstention instruction used by our reader.
// Keep this extension explicit; it is not the unmodified official substring scorer.
export const abstains = text => /no information available|not mentioned|i (?:don't|don’t|do not) have enough information|未提及|没有提及|没有相关信息|无法回答|不知道|无可奉告|没有提到/i.test(String(text));
export const questionIdentity = (conv, index) => `${conv}:${index}`;
