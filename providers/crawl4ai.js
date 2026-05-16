const { execFile } = require("node:child_process");

function crawl4AiEnabled() {
  return process.env.CRAWL4AI_ENABLED !== "false";
}

function pythonCommand() {
  return process.env.CRAWL4AI_PYTHON || "python3";
}

function runPython(script, args = [], timeout = 18000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      pythonCommand(),
      ["-c", script, ...args],
      {
        timeout,
        maxBuffer: 1024 * 1024 * 2,
        env: process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );

    child.stdin?.end();
  });
}

async function hasCrawl4Ai() {
  if (!crawl4AiEnabled()) return false;

  try {
    await runPython("import crawl4ai; print('ok')", [], 6000);
    return true;
  } catch {
    return false;
  }
}

async function crawlUrl(url) {
  if (!crawl4AiEnabled()) {
    throw new Error("Crawl4AI is disabled");
  }

  const script = `
import asyncio, json, sys
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig

async def main():
    url = sys.argv[1]
    browser_config = BrowserConfig(headless=True, verbose=False)
    run_config = CrawlerRunConfig(word_count_threshold=8, remove_overlay_elements=True)
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)
        markdown = getattr(result, "markdown", "") or ""
        cleaned = getattr(result, "cleaned_html", "") or ""
        html = getattr(result, "html", "") or ""
        metadata = getattr(result, "metadata", {}) or {}
        media = getattr(result, "media", {}) or {}
        images = media.get("images") if isinstance(media, dict) else []
        image = ""
        if isinstance(images, list) and images:
            first = images[0]
            image = first.get("src", "") if isinstance(first, dict) else str(first)
        print(json.dumps({
            "markdown": markdown,
            "cleanedHtml": cleaned,
            "html": html,
            "metadata": metadata,
            "image": image
        }))

asyncio.run(main())
`;

  const stdout = await runPython(script, [url], Number(process.env.CRAWL4AI_TIMEOUT_MS || 22000));
  return JSON.parse(stdout);
}

module.exports = {
  crawlUrl,
  hasCrawl4Ai
};
