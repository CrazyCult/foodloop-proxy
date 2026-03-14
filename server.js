const express = require("express")
const axios = require("axios")
const cors = require("cors")

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

// Headers qui imitent Chrome 122 récent
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "fr-CH,fr;q=0.9,de-CH;q=0.8,de;q=0.7,en;q=0.6",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Connection": "keep-alive",
}

// ─── GET /coop?q=poulet ───────────────────────────────────
app.get("/coop", async (req, res) => {
  const { q, pageSize = 15 } = req.query
  if (!q) return res.status(400).json({ error: "q requis" })

  // Essaie d'abord l'endpoint principal, puis le fallback
  const endpoints = [
    {
      url: "https://www.coop.ch/fr/search/results",
      params: {
        q: `${q}:relevance`,
        text: q,
        sort: "relevance",
        pageSize: Number(pageSize),
        format: "json",
      },
      headers: {
        ...BROWSER_HEADERS,
        "Referer": "https://www.coop.ch/fr/search",
        "X-Requested-With": "XMLHttpRequest",
      },
      parse: (data) => data?.contentJsons?.anchors?.[0]?.json?.elements ?? [],
    },
    {
      url: "https://www.coop.ch/api/v1/products/search",
      params: { query: q, pageSize: Number(pageSize), lang: "fr" },
      headers: {
        ...BROWSER_HEADERS,
        "Referer": "https://www.coop.ch/fr/search",
        "Origin": "https://www.coop.ch",
      },
      parse: (data) => data?.products ?? data?.results ?? data?.elements ?? [],
    },
  ]

  for (const endpoint of endpoints) {
    try {
      const resp = await axios.get(endpoint.url, {
        headers: endpoint.headers,
        params: endpoint.params,
        timeout: 12000,
      })
      const elements = endpoint.parse(resp.data)
      if (elements.length > 0) {
        const products = elements.map(parseCoopProduct).filter(Boolean)
        return res.json({ products, count: products.length })
      }
    } catch (err) {
      console.warn(`[coop] Endpoint ${endpoint.url} échoué: ${err.message}`)
    }
  }

  // Tous les endpoints ont échoué
  console.error(`[coop] Tous les endpoints ont échoué pour "${q}"`)
  res.status(500).json({ error: "Coop inaccessible", products: [] })
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

// ─── POST /coop/add ───────────────────────────────────────
app.post("/coop/add", async (req, res) => {
  const { productId, sessionCookie } = req.body
  if (!productId || !sessionCookie) {
    return res.status(400).json({ success: false, error: "productId et sessionCookie requis" })
  }
  try {
    const resp = await axios.post(
      "https://www.coop.ch/fr/shopping-list/list/toggle",
      { productCode: productId },
      {
        headers: {
          ...BROWSER_HEADERS,
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://www.coop.ch/fr/shopping-list",
        },
      }
    )
    res.json({ success: resp.status === 200, status: resp.status })
  } catch (err) {
    console.error(`[coop/add] Erreur produit ${productId}:`, err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

// ─── Parsers ──────────────────────────────────────────────
function parseCoopProduct(el) {
  try {
    // Prix — peut être string "10.05", number, ou objet {value: "10.05"}
    let price = 0
    if (typeof el.price === "number") price = el.price
    else if (typeof el.price === "string") price = parseFloat(el.price)
    else if (el.price?.value) price = parseFloat(el.price.value)
    else if (el.priceFormatted) price = parseFloat(el.priceFormatted.replace(/[^0-9.]/g, ""))

    // Ignorer banners/promos sans id ou href valides
    if (!el.id || String(el.id) === "undefined") return null
    if (!el.href || el.href === "undefined") return null
    if (!el.title) return null
    // Ignorer produits sans prix valide (abonnements, cartes cadeaux, etc.)
    if (!price || price <= 0) return null

    return {
      id: String(el.id),
      title: el.title,
      brand: el.brand ?? "",
      price,
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
