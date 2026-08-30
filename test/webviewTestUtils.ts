import assert from "node:assert/strict";

export function extractGeneratedBrowserScript(webviewSource: string): string {
  const htmlTemplateStart = webviewSource.indexOf("return `<!doctype html>");
  const htmlTemplateEnd = webviewSource.indexOf("`;", htmlTemplateStart);
  assert.notEqual(htmlTemplateStart, -1);
  assert.notEqual(htmlTemplateEnd, -1);

  const htmlTemplate = webviewSource.slice(
    htmlTemplateStart + "return `".length,
    htmlTemplateEnd,
  );
  const generatedHtml = Function(
    "nonce",
    `return \`${htmlTemplate}\`;`,
  )("test-nonce") as string;
  const normalizedHtml = generatedHtml.toLowerCase();
  const scriptTagStart = normalizedHtml.indexOf("<script");
  const scriptContentStart = normalizedHtml.indexOf(">", scriptTagStart) + 1;
  const scriptContentEnd = normalizedHtml.indexOf("</script", scriptContentStart);
  const scriptTagEnd = normalizedHtml.indexOf(">", scriptContentEnd);

  assert.notEqual(scriptTagStart, -1);
  assert.notEqual(scriptContentStart, 0);
  assert.notEqual(scriptContentEnd, -1);
  assert.notEqual(scriptTagEnd, -1);
  return generatedHtml.slice(scriptContentStart, scriptContentEnd);
}
