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
  const browserScript = generatedHtml.match(
    /<script[^>]*>([\s\S]*?)<\/script\s*>/iu,
  )?.[1];
  assert.ok(browserScript);
  return browserScript;
}
