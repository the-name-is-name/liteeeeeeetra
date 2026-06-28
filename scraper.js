const axios = require('axios');
const cheerio = require('cheerio');

class ComicScraper {
    constructor() {
        this.baseUrl = 'https://rcostation.xyz';
        this.userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
        ];
    }

    getRandomHeaders() {
        const ua = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
        return {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': `${this.baseUrl}/`
        };
    }

    // 1. SEARCH FUNCTION
    async searchComic(query) {
        console.log(`[Scraper] Searching for "${query}" (Rotation active)...`);
        try {
            const url = `${this.baseUrl}/Search/Comic`;
            const response = await axios.post(url, `keyword=${encodeURIComponent(query)}`, {
                headers: { 
                    ...this.getRandomHeaders(), 
                    'Content-Type': 'application/x-www-form-urlencoded' 
                }
            });
            
            const $ = cheerio.load(response.data);
            const results = [];
            
            $('.item').each((i, el) => {
                const aTag = $(el).find('a');
                const imgTag = $(el).find('img');
                const title = aTag.text().trim();
                const link = aTag.attr('href');
                const poster = imgTag.attr('src') ? `${this.baseUrl}${imgTag.attr('src')}` : '';
                
                if (title && link) {
                    results.push({ title, link: `${this.baseUrl}${link}`, poster });
                }
            });
            return results;
        } catch (error) {
            console.error("[Scraper] Search failed: ", error.message);
            return [];
        }
    }

    // 2. DETAILS FUNCTION
    async getComicDetails(comicUrl) {
        try {
            const response = await axios.get(comicUrl, { headers: this.getRandomHeaders() });
            const $ = cheerio.load(response.data);
            
            const details = {
                title: $('h1').first().text().trim() || $('title').first().text().split('-')[0].trim()
            };

            let summaryText = '';
            $('p, div, span, td').not('script').not('style').each((i, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                if (text.toLowerCase().startsWith('summary') && text.length > 50 && text.length < 3000 && $el.children().length < 5) {
                    summaryText = text.replace(/^summary[:\s]*/i, '').trim();
                }
            });

            if (!summaryText) {
                $('p').each((i, el) => {
                    const text = $(el).text().trim();
                    if (text.length > 100 && text.length > summaryText.length) {
                        const lowerText = text.toLowerCase();
                        if (!lowerText.includes('home') && !lowerText.includes('comic list') && !lowerText.includes('sort by')) {
                            summaryText = text;
                        }
                    }
                });
            }
            if (summaryText) details.summary = summaryText;

            $('p, li, div, span, td, a').not('script').not('style').each((i, el) => {
                const $el = $(el);
                if ($el.children().length > 3) return; 
                
                const text = $el.text().trim();
                
                if (text.length > 3 && text.length < 150 && text.includes(':')) {
                    const colonIndex = text.indexOf(':');
                    const key = text.substring(0, colonIndex).trim().toLowerCase();
                    const value = text.substring(colonIndex + 1).trim();
                    
                    if (!value || !/^[a-z0-9\s\-_]+$/.test(key)) return;

                    if (key.includes('other name') || key.includes('alternative')) details.otherNames = value;
                    else if (key.includes('genre')) details.genres = value.split(',').map(g => g.trim()).filter(g => g);
                    else if (key.includes('publisher')) details.publisher = value;
                    else if (key.includes('writer') || key.includes('author')) details.writer = value;
                    else if (key.includes('artist') || key.includes('illustrator')) details.artist = value;
                    else if (key.includes('publication date') || key.includes('released') || key.includes('year') || key.includes('date')) details.publicationDate = value;
                    else if (key.includes('status')) details.status = value;
                }
            });

            Object.keys(details).forEach(key => {
                if (details[key] === '' || (Array.isArray(details[key]) && details[key].length === 0)) {
                    delete details[key];
                }
            });

            return details;
        } catch (error) { 
            console.error("[Scraper] Details failed: ", error.message);
            return null; 
        }
    }

    // 3. CHAPTERS / ISSUES FUNCTION
    async getChapters(comicUrl) {
        try {
            const response = await axios.get(comicUrl, { headers: this.getRandomHeaders() });
            const $ = cheerio.load(response.data);
            const chapters = [];
            
            $('ul.chapters li, .chapter-list li, .issues-list li, table.chapters tbody tr').each((i, el) => {
                const aTag = $(el).find('a').first();
                if (aTag.length > 0) {
                    let link = aTag.attr('href');
                    if (link && !link.startsWith('http')) {
                        link = `${this.baseUrl}${link}`;
                    }
                    chapters.push({ 
                        title: aTag.text().trim(),  
                        link: link 
                    });
                }
            });
            return chapters;
        } catch (error) { 
            console.error("[Scraper] Chapters failed: ", error.message);
            return []; 
        }
    }

    // 4. PAGES FUNCTION
    async getPages(chapterUrl) {
        try {
            const response = await axios.get(chapterUrl, { headers: this.getRandomHeaders() });
            const regex = /data-src=\s*['"]\s*(https?:\/\/[^'"\s]+\/uploads\/manga\/[^'"\s]+\.(?:jpg|jpeg|png|webp|gif))\s*['"]/gi;
            const pages = [];
            let match;
            while ((match = regex.exec(response.data)) !== null) {
                pages.push(match[1]);
            }
            return pages;  
        } catch (error) { 
            console.error("[Scraper] Pages failed: ", error.message);
            return []; 
        }
    }
}

module.exports = ComicScraper;