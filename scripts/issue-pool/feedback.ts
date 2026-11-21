const commentPattern =
  /(?:<!-- vercel-comment:|Vercel Toolbar thread ID: |https:\/\/vercel\.com(?:\/[A-Za-z0-9_-]+){1,4}\/c\/)([A-Za-z0-9_-]+)(?![A-Za-z0-9_/?%#-])/g;

export function feedbackCommentIds(body: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of body.matchAll(commentPattern)) {
    const id = match[1];
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}
