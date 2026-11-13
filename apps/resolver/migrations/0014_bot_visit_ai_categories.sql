-- 0014: bot visits split AI bots three ways, following the split the AI
-- companies document: ai_crawler (model training and data collection),
-- ai_search (indexing for AI answer engines) and ai_assistant (a single fetch
-- because a person asked an AI tool about the page). Forward-only and additive:
-- the category check gains two values and keeps every existing one, so every
-- stored row stays valid and older website packages keep sending ai_crawler
-- for all AI bots. No other column, table, index or grant changes.
ALTER TABLE bot_visits DROP CONSTRAINT IF EXISTS bot_visits_bot_category_check;
ALTER TABLE bot_visits ADD CONSTRAINT bot_visits_bot_category_check
  CHECK (bot_category IN ('ai_crawler', 'ai_search', 'ai_assistant', 'search_engine', 'seo_tool', 'social_preview', 'monitoring', 'other'));
