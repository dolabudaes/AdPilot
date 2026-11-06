export function conversationWindow<T extends { role: "user" | "assistant" }>(messages: T[], limit = 8) {
  if (messages.length <= limit) return { visible: messages, hiddenCount: 0 };

  let start = messages.length - limit;
  if (messages[start]?.role === "assistant" && messages[start - 1]?.role === "user") start -= 1;

  return {
    visible: messages.slice(start),
    hiddenCount: start,
  };
}
