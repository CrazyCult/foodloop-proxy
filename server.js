const express = require("express")
const axios = require("axios")
const cors = require("cors")

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

// Headers qui imitent un vrai navigateur
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "fr-CH,fr;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.coop.ch/fr/search",
  "X-Requested-With": "XMLHttpRequest",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
}

// ─── GET /coop?q=poulet ───────────────────────────────────
app.get("/coop", async (req, res) => {
  const { q, pageSize = 15 } = req.query
  if (!q) return res.status(400).json({ error: "q requis" })

  try {
    const resp = await axios.get("https://www.coop.ch/fr/search/results", {
      headers: { ...BROWSER_HEADERS, Referer: "https://www.coop.ch/fr/search" },
      params: {
        q: `${q}:relevance`,
        text: q,
        sort: "relevance",
        pageSize: Number(pageSize),
      },
      timeout: 10000,
    })

    const elements = resp.data?.contentJsons?.anchors?.[0]?.json?.elements ?? []
    const products = elements.map(parseCoopProduct).filter(Boolean)
    res.json({ products, count: products.length })

  } catch (err) {
    console.error(`[coop] Erreur pour "${q}":`, err.message)
    res.status(500).json({ error: err.message, products: [] })
  }
})

// ─── GET /migros?q=poulet ─────────────────────────────────
app.get("/migros", async (req, res) => {
  const { q, pageSize = 15 } = req.query
  if (!q) return res.status(400).json({ error: "q requis" })

  try {
    const resp = await axios.get("https://www.migros.ch/api/product/search/v1", {
      headers: { ...BROWSER_HEADERS, Referer: "https://www.migros.ch/fr/search" },
      params: {
        query: q,
        limit: Number(pageSize),
        offset: 0,
        lang: "fr",
      },
      timeout: 10000,
    })

    const hits = resp.data?.hits ?? resp.data?.products ?? []
    const products = hits.map(parseMigrosProduct).filter(Boolean)
    res.json({ products, count: products.length })

  } catch (err) {
    console.error(`[migros] Erreur pour "${q}":`, err.message)
    res.status(500).json({ error: err.message, products: [] })
  }
})

// ─── GET /health ──────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", ts: Date.now() }))

// ─── Parsers ──────────────────────────────────────────────
function parseCoopProduct(el) {
  try {
    return {
      id: String(el.id),
      title: el.title,
      brand: el.brand ?? "",
      price: parseFloat(el.price ?? "0"),
      quantity: el.quantity ?? "",
      pricePer100g: parseFloat(el.priceContextPrice ?? "0"),
      url: `https://www.coop.ch${el.href}`,
      store: "coop",
      labels: (el.declarationIconsText ?? []).map(l => l.toLowerCase()),
      rating: parseFloat(el.ratingValue ?? "0"),
      reviewCount: parseInt(el.ratingAmount ?? "0", 10),
      imageUrl: el.image?.src,
    }
  } catch { return null }
}

function parseMigrosProduct(el) {
  try {
    const price = el.price?.value ?? el.price ?? 0
    const weightG = el.weightInGrams ?? el.weight ?? 0
    const pricePer100g = weightG > 0 ? (price / weightG) * 100 : 0
    const labels = []
    if (el.isBio || el.organic) labels.push("bio")
    if (el.isFairtrade || el.fairtrade) labels.push("fairtrade")
    if (el.isVegan || el.vegan) labels.push("vegan")
    if (el.isVegetarian) labels.push("végétarien")
    if (el.origin?.toLowerCase().includes("suisse")) labels.push("local")
    return {
      id: String(el.id ?? el.productId),
      title: el.name ?? el.title,
      brand: el.brand?.name ?? el.brand ?? "",
      price: parseFloat(price),
      quantity: el.quantity ?? el.weightStr ?? "",
      pricePer100g: parseFloat(pricePer100g.toFixed(3)),
      url: `https://www.migros.ch/fr/product/${el.id ?? el.productId}`,
      store: "migros",
      labels,
      rating: parseFloat(el.rating?.average ?? el.ratingValue ?? "0"),
      reviewCount: parseInt(el.rating?.count ?? el.reviewCount ?? "0", 10),
      imageUrl: el.image?.url ?? el.imageUrl,
    }
  } catch { return null }
}

app.listen(PORT, () => console.log(`✅ Proxy FoodLoop sur port ${PORT}`))
