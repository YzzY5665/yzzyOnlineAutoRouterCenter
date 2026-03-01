require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 1. ORIGIN WHITELIST ---
// List of allowed origins. If empty, all origins are accepted.
const ALLOWED_ORIGINS = [];

function checkOrigin(req, res) {
    if (ALLOWED_ORIGINS.length === 0) return true;
    const origin = req.headers['origin'];
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        res.status(403).json({ state: "error", content: "Origin not allowed" });
        return false;
    }
    return true;
}

// --- 2. DYNAMIC AI MAP ---
const getTierConfig = (lv, defaultVal) => {
    const config = process.env[`TIER_${lv}`] || defaultVal;
    const [provider, model] = config.split(':');
    return { provider, model };
};

const AI_MAP = {
    1:  getTierConfig(1,  'gemini:gemini-2.0-flash'),
    2:  getTierConfig(2,  'groq:llama-3.3-70b-versatile'),
    3:  getTierConfig(3,  'gemini:gemini-2.0-flash'),
    4:  getTierConfig(4,  'mistral:mistral-small-latest'),
    5:  getTierConfig(5,  'groq:llama-3.3-70b-specdec'),
    6:  getTierConfig(6,  'cerebras:llama-3.3-70b'),
    7:  getTierConfig(7,  'mistral:mistral-large-latest'),
    8:  getTierConfig(8,  'groq:llama-3.3-70b-versatile'),
    9:  getTierConfig(9,  'gemini:gemini-2.0-pro-exp'),
    10: getTierConfig(10, 'gemini:gemini-2.0-pro-exp')
};

// --- 3. UTILS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getSafeTier(lv) {
    let safe = Math.abs(lv);
    if (safe === 0) return 1;
    return Math.min(Math.max(safe, 1), 10);
}

// Timing-safe secret comparison to prevent timing attacks
function checkSecret(provided) {
    const expected = process.env.MY_APP_SECRET || '';
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(
        Buffer.from(provided),
        Buffer.from(expected)
    );
}

// --- 4. PROVIDER CALL ---
async function callAIProvider(lv, prompt) {
    const { provider, model } = AI_MAP[lv];
    let url, data, headers = { "Content-Type": "application/json" };

    const systemPreface = `
[PROTOCOL: JSON-ONLY]
You are a specialized AI node. You must respond ONLY with a valid JSON object.
The output MUST follow this schema:
{
  "state": "complete",
  "package": <CONTENT>
}

If the request is too difficult for your current tier (${lv}), return:
{
  "state": "too_complex",
  "package": "climb"
}

`;

    if (provider === 'gemini') {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_KEY}`;
        data = {
            contents: [{ parts: [{ text: `${systemPreface}\n\nTask: ${prompt}` }] }],
            generationConfig: { responseMimeType: "application/json" }
        };
    } else {
        if (provider === 'groq') {
            url = "https://api.groq.com/openai/v1/chat/completions";
        } else if (provider === 'mistral') {
            url = "https://api.mistral.ai/v1/chat/completions";
        } else if (provider === 'cerebras') {
            url = "https://api.cerebras.ai/v1/chat/completions";
        }

        headers["Authorization"] = `Bearer ${process.env[`${provider.toUpperCase()}_KEY`]}`;
        data = {
            model,
            messages: [{ role: "user", content: `${systemPreface}\n\nTask: ${prompt}` }],
            response_format: { type: "json_object" }
        };
    }

    // --- FIX: Actually send the request and return parsed result ---
    const response = await axios.post(url, data, { headers });

    let raw;
    if (provider === 'gemini') {
        raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    } else {
        raw = response.data.choices?.[0]?.message?.content;
    }

    if (!raw) throw new Error(`Empty response from tier ${lv}`);

    return JSON.parse(raw);
}

// --- 5. FULL SWEEP CASCADE ENGINE ---
async function executeFullSweep(initialLevel, userPrompt) {
    let currentLevel = getSafeTier(initialLevel);
    let visited = new Set();

    while (visited.size < 10) {
        // If current is visited, find the next unvisited tier by scanning 1-10 in order
        if (visited.has(currentLevel)) {
            let found = false;
            for (let i = 1; i <= 10; i++) {
                if (!visited.has(i)) {
                    currentLevel = i;
                    found = true;
                    break;
                }
            }
            if (!found) break;
        }

        visited.add(currentLevel);

        try {
            console.log(`[Sweep] Attempting Tier ${currentLevel}... (${visited.size}/10)`);
            const result = await callAIProvider(currentLevel, userPrompt);

            if (result.state === "too_complex" && currentLevel < 10) {
                console.log(`[Upward] Tier ${currentLevel} escalating...`);
                currentLevel++;
                continue;
            }

            return result.package;

        } catch (err) {
            const status = err.response ? err.response.status : "No Response";
            console.error(`[Failure] Tier ${currentLevel} Status: ${status}`);

            if (status === 503 || status === 429) {
                console.log("⚠️ Rate limit or Busy. Cooling down 1.5s...");
                await sleep(1500);
            }

            currentLevel--;
        }
    }
    return null;
}

// --- 6. APP ROUTES ---
app.get('/wake', (req, res) => res.status(200).send("Full Sweep Online"));

app.post('/ask-ai', async (req, res) => {
    if (!checkOrigin(req, res)) return;

    const { secret, complexity, prompt } = req.body;
    if (!secret || !checkSecret(secret)) return res.status(403).send("Forbidden");

    const result = await executeFullSweep(complexity, prompt);

    if (result) {
        res.json({ state: "complete", package: { package: result } });
    } else {
        res.status(503).json({ state: "error", content: "All 10 tiers exhausted" });
    }
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Middleware listening on port ${PORT} at 0.0.0.0`);
});

server.keepAliveTimeout = 125000;