require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const ComicScraper = require('./scraper'); // Your preview scraper

const app = express();
const PORT = process.env.PORT || 3000;
const scraper = new ComicScraper();

// Middleware
app.use(cors());
app.use(express.json());

// 🔒 Supabase Client (Keys hidden in .env, NEVER in frontend)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 📖 YOUR PREVIEW/READER ROUTES (Preserved + Fixed for Render)
// ==========================================
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: "Missing search query '?q='" });
        const results = await scraper.searchComic(query);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: "Search failed", details: err.message });
    }
});

app.get('/api/details', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "Missing URL" });
        const details = await scraper.getComicDetails(url);
        if (!details) return res.status(404).json({ error: "Could not fetch details" });
        res.json(details);
    } catch (err) {
        res.status(500).json({ error: "Details failed", details: err.message });
    }
});

app.get('/api/chapters', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "Missing URL" });
        const chapters = await scraper.getChapters(url);
        res.json(chapters);
    } catch (err) {
        res.status(500).json({ error: "Chapters fetch failed", details: err.message });
    }
});

app.get('/api/pages', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).json({ error: "Missing URL" });
        const rawPages = await scraper.getPages(url);

        // 🚨 DYNAMIC PROXY FIX: Replaces hardcoded localhost with your actual deployed URL
        const baseUrl = req.protocol + '://' + req.get('host');
        const proxiedPages = rawPages.map(pageUrl =>
            `${baseUrl}/api/proxy-image?url=${encodeURIComponent(pageUrl)}`
        );
        res.json(proxiedPages);
    } catch (err) {
        res.status(500).json({ error: "Pages fetch failed", details: err.message });
    }
});

app.get('/api/proxy-image', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing image URL parameter");
    try {
        const response = await axios({
            url: targetUrl,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': scraper.getRandomHeaders()['User-Agent'],
                'Referer': 'https://rcostation.xyz/'
            }
        });
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send("Failed to load image");
    }
});

// ==========================================
// 📦 COLLECTION & DATABASE ROUTES
// ==========================================
app.get('/api/collection', async (req, res) => {
    try {
        const { owner } = req.query; // 'Me' or 'Friend'
        const { data, error } = await supabase
            .from('collection')
            .select('*')
            .eq('owner', owner || 'Me')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch collection", details: err.message });
    }
});

app.post('/api/collection', async (req, res) => {
    try {
        const { title, image_url, comic_url, owner, price, store } = req.body;
        if (!title || !owner) return res.status(400).json({ error: "Missing title or owner" });

        const { data, error } = await supabase
            .from('collection')
            .insert({ title, image_url, comic_url, owner, price: price || 'N/A', store: store || 'Unknown' })
            .select();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to add comic", details: err.message });
    }
});

app.delete('/api/collection/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('collection')
            .delete()
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete comic", details: err.message });
    }
});

// ==========================================
// 💡 RECOMMENDATIONS ROUTE
// ==========================================
app.get('/api/recommendations', async (req, res) => {
    try {
        const { forUser } = req.query; // 'Me' or 'Friend'
        const otherUser = forUser === 'Me' ? 'Friend' : 'Me';

        const { data: myData } = await supabase.from('collection').select('title').eq('owner', forUser);
        const { data: otherData } = await supabase.from('collection').select('*').eq('owner', otherUser);

        const myTitles = new Set((myData || []).map(c => c.title.toLowerCase()));
        const recommendations = (otherData || []).filter(c => !myTitles.has(c.title.toLowerCase()));

        res.json(recommendations.slice(0, 6)); // Limit to 6
    } catch (err) {
        res.status(500).json({ error: "Failed to get recommendations", details: err.message });
    }
});

// ==========================================
// 🇸🇦 KSA PRICE CHECKER (Amazon.sa, Jarir, Virgin)
// ==========================================
app.get('/api/ksa-prices', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Missing query" });

    const prices = { amazon: 'Not found', jarir: 'Not found', virgin: 'Not found' };

    // 1. Amazon.sa
    try {
        const amzRes = await axios.get(`https://www.amazon.sa/s?k=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 5000
        });
        const $a = cheerio.load(amzRes.data);
        const priceEl = $a('.a-price-whole').first();
        if (priceEl.length) prices.amazon = `${priceEl.text().trim()} SAR`;
    } catch (e) { prices.amazon = 'Blocked/Captcha'; }

    // 2. Jarir Bookstore
    try {
        const jarirRes = await axios.get(`https://www.jarir.com/catalogsearch/result/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        const $j = cheerio.load(jarirRes.data);
        const priceEl = $j('.price').first();
        if (priceEl.length) prices.jarir = `${priceEl.text().trim()}`;
    } catch (e) { prices.jarir = 'Not found'; }

    // 3. Virgin Megastore KSA
    try {
        const virginRes = await axios.get(`https://www.virginmegastore.sa/ar/search/?text=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        const $v = cheerio.load(virginRes.data);
        const priceEl = $v('.price-value').first();
        if (priceEl.length) prices.virgin = `${priceEl.text().trim()}`;
    } catch (e) { prices.virgin = 'Not found'; }

    res.json(prices);
});

// Health Check
app.get('/', (req, res) => {
    res.send('<h1>🦇 ComicVault KSA API is Running!</h1><p>Use /api/search?q=batman to test.</p>');
});

app.listen(PORT, () => {
    console.log(`✅ Server initialized. API running on port ${PORT}`);
});