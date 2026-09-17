function resolveChannel(channelParam) {
  if (!channelParam || channelParam === "all") return null;
  return channelParam;
}
function resolveOwner(view) {
  if (view === "ai") return "bot";
  if (view === "human") return "human";
  return null;
}

export { resolveChannel, resolveOwner };
