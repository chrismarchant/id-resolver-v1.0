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
      ai_crawler: ["GPTBot", "ClaudeBot", "anthropic-ai", "Google-Extended", "Applebot-Extended", "Google-CloudVertexBot", "CCBot", "Bytespider", "Meta-ExternalAgent", "FacebookBot", "Amazonbot", "cohere-training-data-crawler", "cohere-ai", "Diffbot", "AI2Bot", "Timpibot", "ImagesiftBot"],
      ai_search: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "YouBot"],
      ai_assistant: ["ChatGPT-User", "Claude-User", "Perplexity-User", "Meta-ExternalFetcher", "MistralAI-User", "DuckAssistBot", "Google-NotebookLM"],
      search_engine: ["Googlebot", "Google-InspectionTool", "GoogleOther", "Bingbot", "DuckDuckBot", "YandexBot", "Applebot", "Baiduspider", "PetalBot", "SeznamBot", "MojeekBot", "Slurp"],
      seo_tool: ["AhrefsBot", "AhrefsSiteAudit", "SemrushBot", "SiteAuditBot", "MJ12bot", "DotBot", "rogerbot", "BLEXBot", "DataForSeoBot", "serpstatbot", "Screaming Frog SEO Spider", "Barkrowler"],
      social_preview: ["facebookexternalhit", "LinkedInBot", "TelegramBot", "Twitterbot", "Slackbot", "WhatsApp", "Discordbot", "Pinterestbot", "redditbot", "Embedly", "SkypeUriPreview", "Mastodon"],
      monitoring: ["UptimeRobot", "Pingdom", "StatusCake", "Site24x7", "Better Uptime", "Chrome-Lighthouse", "GTmetrix"],
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
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot", "ai_search", "OAI-SearchBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User", "ai_assistant", "ChatGPT-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@example.com)", "ClaudeBot", "ai_crawler", "ClaudeBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@example.com)", "Claude-User", "ai_assistant", "Claude-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot", "ai_search", "PerplexityBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)", "Perplexity-User", "ai_assistant", "Perplexity-User"],
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
    // Added with the AI split (ai_crawler, ai_search, ai_assistant) and the longer list.
    ["Mozilla/5.0 (compatible; anthropic-ai/1.0)", "anthropic-ai", "ai_crawler", "anthropic-ai"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-CloudVertexBot; +https://cloud.google.com/)", "Google-CloudVertexBot", "ai_crawler", "Google-CloudVertexBot"],
    ["Mozilla/5.0 (compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/webmasters/facebookbot/)", "FacebookBot", "ai_crawler", "FacebookBot"],
    ["cohere-training-data-crawler/1.0", "cohere-training-data-crawler", "ai_crawler", "cohere-training-data-crawler"],
    ["cohere-ai", "cohere-ai", "ai_crawler", "cohere-ai"],
    ["Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)", "Diffbot", "ai_crawler", "Diffbot"],
    ["Mozilla/5.0 (compatible; AI2Bot; +https://www.allenai.org/crawler)", "AI2Bot", "ai_crawler", "AI2Bot"],
    ["Timpibot/0.8 (+http://www.timpi.io)", "Timpibot", "ai_crawler", "Timpibot"],
    ["Mozilla/5.0 (compatible; ImagesiftBot; +imagesift.com)", "ImagesiftBot", "ai_crawler", "ImagesiftBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +claude-searchbot@example.com)", "Claude-SearchBot", "ai_search", "Claude-SearchBot"],
    ["Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)", "YouBot", "ai_search", "YouBot"],
    ["meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta-ExternalFetcher", "ai_assistant", "meta-externalfetcher"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)", "MistralAI-User", "ai_assistant", "MistralAI-User"],
    ["DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)", "DuckAssistBot", "ai_assistant", "DuckAssistBot"],
    ["Google-NotebookLM", "Google-NotebookLM", "ai_assistant", "Google-NotebookLM"],
    ["Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)", "Google-InspectionTool", "search_engine", "Google-InspectionTool"],
    ["Mozilla/5.0 (compatible; GoogleOther)", "GoogleOther", "search_engine", "GoogleOther"],
    ["Mozilla/5.0 (compatible; SeznamBot/4.0; +https://o-seznam.cz/napoveda/vyhledavani/en/seznambot-crawler/)", "SeznamBot", "search_engine", "SeznamBot"],
    ["Mozilla/5.0 (compatible; MojeekBot/0.11; +https://www.mojeek.com/bot.html)", "MojeekBot", "search_engine", "MojeekBot"],
    ["Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)", "Slurp", "search_engine", "Slurp"],
    ["Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/site-audit)", "AhrefsSiteAudit", "seo_tool", "AhrefsSiteAudit"],
    ["Mozilla/5.0 (compatible; SiteAuditBot/0.97; +http://www.semrush.com/bot.html)", "SiteAuditBot", "seo_tool", "SiteAuditBot"],
    ["rogerbot/1.2 (https://moz.com/help/guides/moz-procedures/what-is-rogerbot, rogerbot-crawler@example.com)", "rogerbot", "seo_tool", "rogerbot"],
    ["Mozilla/5.0 (compatible; BLEXBot/1.0; +https://help.seranking.com/en/blex-crawler)", "BLEXBot", "seo_tool", "BLEXBot"],
    ["Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)", "DataForSeoBot", "seo_tool", "DataForSeoBot"],
    ["serpstatbot/2.1 (advanced backlink tracking bot; https://serpstatbot.com/; abuse@example.com)", "serpstatbot", "seo_tool", "serpstatbot"],
    ["Screaming Frog SEO Spider/21.0", "Screaming Frog SEO Spider", "seo_tool", "Screaming"],
    ["Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)", "Barkrowler", "seo_tool", "Barkrowler"],
    ["TelegramBot (like TwitterBot)", "TelegramBot", "social_preview", "TelegramBot"],
    ["Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)", "Pinterestbot", "social_preview", "Pinterestbot"],
    ["Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)", "redditbot", "social_preview", "redditbot"],
    ["Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)", "Embedly", "social_preview", "Embedly"],
    ["Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5", "SkypeUriPreview", "social_preview", "SkypeUriPreview"],
    ["http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.example/)", "Mastodon", "social_preview", "Mastodon"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 StatusCake", "StatusCake", "monitoring", "StatusCake"],
    ["Site24x7", "Site24x7", "monitoring", "Site24x7"],
    ["Better Uptime Bot Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Better Uptime", "monitoring", "Better"],
    ["Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 Chrome-Lighthouse", "Chrome-Lighthouse", "monitoring", "Chrome-Lighthouse"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 GTmetrix", "GTmetrix", "monitoring", "GTmetrix"],
    // Anything else that calls itself a bot, crawler or spider.
    ["Mozilla/5.0 (Linux; Android 7.0;) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "PetalBot", "search_engine", "PetalBot"],
    ["AdsBot-Google (+http://www.google.com/adsbot.html)", "Generic bot", "other", "AdsBot-Google"],
    ["Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)", "Baiduspider", "search_engine", "Baiduspider"],
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
    ["Pinterest app", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [Pinterest/iOS]"],
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
    expect(matchBot("Claude-SearchBot/1.0")?.botName).toBe("Claude-SearchBot");
    expect(matchBot("meta-externalagent/1.1")?.botCategory).toBe("ai_crawler");
    expect(matchBot("meta-externalfetcher/1.1")?.botCategory).toBe("ai_assistant");
    expect(matchBot("DuckAssistBot/1.2")?.botName).toBe("DuckAssistBot");
    expect(matchBot("DuckDuckBot/1.1")?.botName).toBe("DuckDuckBot");
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
