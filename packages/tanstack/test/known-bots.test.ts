import { describe, expect, it } from "vitest";
import { BOT_CATEGORIES, KNOWN_BOTS, matchBot, USER_AGENT_SCAN_MAX } from "../src/known-bots.js";

/** The resolver's shape rules (apps/resolver/src/contracts/bot-visit.ts); every match must pass them. */
const BOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const USER_AGENT_FAMILY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

describe("KNOWN_BOTS: the one bot list", () => {
  it("holds exactly the requested names per category, in match order, with unique names", () => {
    const byCategory: Record<string, string[]> = {};
    for (const b of KNOWN_BOTS) (byCategory[b.category] ??= []).push(b.name);
    expect(byCategory).toEqual({
      ai_crawler: ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider", "Meta-ExternalAgent", "Amazonbot"],
      search_engine: ["Googlebot", "Bingbot", "DuckDuckBot", "YandexBot", "Applebot"],
      seo_tool: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot"],
      social_preview: ["facebookexternalhit", "LinkedInBot", "Twitterbot", "Slackbot", "WhatsApp", "Discordbot"],
      monitoring: ["UptimeRobot", "Pingdom"],
      other: ["Generic bot", "Generic crawler", "Generic spider"],
    });
    expect(new Set(KNOWN_BOTS.map((b) => b.name.toLowerCase())).size).toBe(KNOWN_BOTS.length);
    for (const b of KNOWN_BOTS) {
      expect(BOT_CATEGORIES).toContain(b.category);
      expect(b.name).toMatch(BOT_NAME_PATTERN);
    }
    // The generic entries come last, so a named bot always wins.
    expect(KNOWN_BOTS.slice(-3).every((b) => b.category === "other")).toBe(true);
  });
});

describe("matchBot", () => {
  it.each([
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot", "ai_crawler", "GPTBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot", "ai_crawler", "OAI-SearchBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User", "ai_crawler", "ChatGPT-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@example.com)", "ClaudeBot", "ai_crawler", "ClaudeBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@example.com)", "Claude-User", "ai_crawler", "Claude-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot", "ai_crawler", "PerplexityBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "Perplexity-User", "ai_crawler", "Perplexity-User"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot", "ai_crawler", "CCBot"],
    ["Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@example.com)", "Bytespider", "ai_crawler", "Bytespider"],
    ["meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta-ExternalAgent", "ai_crawler", "meta-externalagent"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045 Safari/537.36", "Amazonbot", "ai_crawler", "Amazonbot"],
    ["Mozilla/5.0 (compatible; Applebot-Extended/0.1)", "Applebot-Extended", "ai_crawler", "Applebot-Extended"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "Google-Extended", "ai_crawler", "Google-Extended"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot", "search_engine", "Googlebot"],
    ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot", "search_engine", "Googlebot"],
    ["Googlebot-Image/1.0", "Googlebot", "search_engine", "Googlebot-Image"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot", "search_engine", "bingbot"],
    ["DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)", "DuckDuckBot", "search_engine", "DuckDuckBot"],
    ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", "YandexBot", "search_engine", "YandexBot"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "Applebot", "search_engine", "Applebot"],
    ["Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "AhrefsBot", "seo_tool", "AhrefsBot"],
    ["Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", "SemrushBot", "seo_tool", "SemrushBot"],
    ["Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "MJ12bot", "seo_tool", "MJ12bot"],
    ["Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@example.com)", "DotBot", "seo_tool", "DotBot"],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "facebookexternalhit", "social_preview", "facebookexternalhit"],
    ["LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", "LinkedInBot", "social_preview", "LinkedInBot"],
    ["Twitterbot/1.0", "Twitterbot", "social_preview", "Twitterbot"],
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Slackbot", "social_preview", "Slackbot-LinkExpanding"],
    ["WhatsApp/2.23.20 A", "WhatsApp", "social_preview", "WhatsApp"],
    ["Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "Discordbot", "social_preview", "Discordbot"],
    ["Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)", "UptimeRobot", "monitoring", "UptimeRobot"],
    ["Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)", "Pingdom", "monitoring", "Pingdom"],
    // Anything else that calls itself a bot, crawler or spider.
    ["Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "Generic bot", "other", "PetalBot"],
    ["AdsBot-Google (+http://www.google.com/adsbot.html)", "Generic bot", "other", "AdsBot-Google"],
    ["Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)", "Generic spider", "other", "Baiduspider"],
    ["Mozilla/5.0 (compatible; Seekport Crawler; http://seekport.com/)", "Generic crawler", "other", "Crawler"],
  ])("%s", (ua, name, category, family) => {
    const m = matchBot(ua);
    expect(m).toEqual({ botName: name, botCategory: category, userAgentFamily: family });
    expect(m!.botName).toMatch(BOT_NAME_PATTERN);
    expect(m!.userAgentFamily).toMatch(USER_AGENT_FAMILY_PATTERN);
  });

  it.each([
    ["Chrome desktop", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"],
    ["Safari iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"],
    ["Firefox", "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0"],
    ["Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"],
    ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36"],
    ["LinkedIn app browser", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1"],
    ["Facebook app browser", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]"],
    ["Slack desktop", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.97 Chrome/130.0 Electron/33.0.0 Safari/537.36"],
    ["Cubot phone", "Mozilla/5.0 (Linux; Android 12; CUBOT KINGKONG 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"],
    ["Cubot phone (underscore model)", "Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"],
  ])("a human browser (%s) is not a bot", (_label, ua) => {
    expect(matchBot(ua)).toBeNull();
  });

  it("matches on token boundaries only", () => {
    expect(matchBot("Mozilla/5.0 XGPTBotY")).toBeNull();
    expect(matchBot("Mozilla/5.0 (compatible; MyGPTBot/1.0)")).toEqual({ botName: "Generic bot", botCategory: "other", userAgentFamily: "MyGPTBot" });
  });

  it("names Applebot-Extended before Applebot, and Claude-User apart from ClaudeBot", () => {
    expect(matchBot("Applebot-Extended/0.1")?.botName).toBe("Applebot-Extended");
    expect(matchBot("Applebot/0.1")?.botName).toBe("Applebot");
    expect(matchBot("Claude-User/1.0")?.botName).toBe("Claude-User");
    expect(matchBot("ClaudeBot/1.0")?.botName).toBe("ClaudeBot");
  });

  it("returns null for a missing or empty user agent, and never returns the user agent itself", () => {
    expect(matchBot(null)).toBeNull();
    expect(matchBot(undefined)).toBeNull();
    expect(matchBot("")).toBeNull();
    expect(matchBot("   ")).toBeNull();
    const ua = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot) extra-detail-123";
    expect(JSON.stringify(matchBot(ua))).not.toContain("openai.com");
    expect(JSON.stringify(matchBot(ua))).not.toContain("1.2");
  });

  it("examines a bounded prefix of a long user agent and keeps the family within 64 characters", () => {
    expect(matchBot("x ".repeat(USER_AGENT_SCAN_MAX) + "GPTBot/1.0")).toBeNull();
    const longToken = "A".repeat(80) + "Bot";
    expect(matchBot(`Mozilla/5.0 (${longToken})`)).toBeNull();
    const m = matchBot("Googlebot-" + "x".repeat(100));
    expect(m?.botName).toBe("Googlebot");
    expect(m!.userAgentFamily.length).toBeLessThanOrEqual(64);
    expect(m!.userAgentFamily).toMatch(USER_AGENT_FAMILY_PATTERN);
  });
});
