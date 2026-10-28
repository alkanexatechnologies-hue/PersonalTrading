-- NSA_MARKET sample queries. In VS Code: connect to localhost (SQL Server extension), select a query, then Cmd+Shift+E.
-- Tables: index_daily (daily OHLC), index_minute (index spot every minute), option_minute (ATM ±3 CE / PE every minute).
-- Times are IST. atm_offset: 0 = ATM, +1 = one strike above, −1 = one strike below.
USE NSA_MARKET;

-- 1) What is in the database
SELECT index_name, MIN(trade_date) AS first_day, MAX(trade_date) AS last_day, COUNT(*) AS sessions
FROM dbo.index_daily GROUP BY index_name ORDER BY index_name;

-- 2) NIFTY daily OHLC, last 20 sessions
SELECT TOP 20 trade_date, [open], [high], [low], [close], [high] - [low] AS day_range
FROM dbo.index_daily WHERE index_name = 'NIFTY' ORDER BY trade_date DESC;

-- 3) Gap up / gap down days (open vs previous close), NIFTY
SELECT trade_date, prev_close, [open], [open] - prev_close AS gap_pts,
       CASE WHEN [open] - prev_close <= -100 THEN 'BIG GAP DOWN' WHEN [open] - prev_close <= -50 THEN 'GAP DOWN 50-100'
            WHEN [open] - prev_close >= 100 THEN 'BIG GAP UP' WHEN [open] - prev_close >= 50 THEN 'GAP UP 50-100' ELSE 'FLAT' END AS gap_type
FROM (SELECT *, LAG([close]) OVER (ORDER BY trade_date) AS prev_close FROM dbo.index_daily WHERE index_name = 'NIFTY') d
WHERE prev_close IS NOT NULL ORDER BY trade_date DESC;

-- 4) One day's NIFTY minute chart (change the date)
SELECT bar_time, spot FROM dbo.index_minute
WHERE index_name = 'NIFTY' AND trade_date = '2026-10-23' ORDER BY bar_time;

-- 5) ATM CE and PE premium every 5 minutes on a day
SELECT bar_time, option_type, strike, [close] AS premium, oi, iv
FROM dbo.option_minute
WHERE index_name = 'NIFTY' AND trade_date = '2026-10-23' AND atm_offset = 0 AND DATEPART(MINUTE, bar_time) % 5 = 0
ORDER BY bar_time, option_type;

-- 6) 15-minute candles of NIFTY built from the minutes
SELECT trade_date, DATEADD(MINUTE, (DATEDIFF(MINUTE, CAST(trade_date AS DATETIME2(0)), bar_time) - 555) / 15 * 15 + 555, CAST(trade_date AS DATETIME2(0))) AS candle_start,
       MAX(spot) AS [high], MIN(spot) AS [low], COUNT(*) AS minutes
FROM dbo.index_minute WHERE index_name = 'NIFTY' AND trade_date = '2026-10-23'
GROUP BY trade_date, (DATEDIFF(MINUTE, CAST(trade_date AS DATETIME2(0)), bar_time) - 555) / 15 ORDER BY candle_start;

-- 7) Biggest up and down days in two years, every index
SELECT TOP 10 index_name, trade_date, [open], [close], [close] - [open] AS move_pts FROM dbo.index_daily ORDER BY ABS([close] - [open]) DESC;

-- ================= The app's own records (refreshed daily after 15:50 with the market data) =================
-- 8) 🎯 One Trade results, day by day (P&L per lot)
SELECT trade_date, index_name, side, strike, opened_at, entry_prem, result, exit_prem, pnl_per_lot FROM dbo.app_one_trade ORDER BY opened_at DESC;
SELECT COUNT(*) AS trades, SUM(CASE WHEN pnl_per_lot > 0 THEN 1 ELSE 0 END) AS wins, SUM(pnl_per_lot) AS total_per_lot FROM dbo.app_one_trade;

-- 9) Co-pilot trades (from 29 Oct 2026; history starts with the app change of that day)
SELECT trade_date, index_name, side, strike, opened_at, entry_prem, state, exit_why, exit_prem, pnl_per_lot FROM dbo.app_copilot_trades ORDER BY opened_at DESC;

-- 10) Your own trade calls (Learning) and how they ended
SELECT trade_date, trade_time, index_name, strike, side, price, sl, targets, result, best FROM dbo.app_learning_trades ORDER BY trade_date DESC, trade_time;

-- 11) System decisions per day (how often it said BULLISH / BEARISH)
SELECT trade_date, index_name, direction, COUNT(*) AS decisions FROM dbo.app_decisions WHERE record_type = 'decision'
GROUP BY trade_date, index_name, direction ORDER BY trade_date DESC, index_name;

-- 12) End-of-day market diary
SELECT trade_date, index_name, prev_close, [open], [high], [low], [close], change_pts FROM dbo.app_market_diary ORDER BY trade_date DESC;
