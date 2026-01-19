require("dotenv").config()
const fs = require("fs")
const { Telegraf, Markup } = require("telegraf")
const axios = require("axios")
const pdf = require("pdf-parse")
const Tesseract = require("tesseract.js")
const port = Number(process.env.PORT || 3000)
const hookPath = process.env.WEBHOOK_PATH || `/tg/${process.env.BOT_TOKEN}`
const domain = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_DOMAIN

const allowedUsers = new Set(
  (process.env.ALLOWED_USERS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
)

function isAllowed(ctx) {
  if (allowedUsers.size === 0) return true
  const id = String(ctx.from?.id || "")
  return allowedUsers.has(id)
}

const { google } = require("googleapis")

const bot = new Telegraf(process.env.BOT_TOKEN)

const Meses = {
  JAN: "01",
  FEV: "02",
  MAR: "03",
  ABR: "04",
  MAI: "05",
  JUN: "06",
  JUL: "07",
  AGO: "08",
  SET: "09",
  OUT: "10",
  NOV: "11",
  DEZ: "12",
}

const CATEGORIES = [
  { code: 1, label: "Supermercado", sheet: "🛒 Supermercado" },
  { code: 2, label: "Alimentação", sheet: "🍔 Alimentação" },
  { code: 3, label: "Transporte", sheet: "🚗 Transporte" },
  { code: 4, label: "Lazer", sheet: "🎉 Lazer" },
  { code: 5, label: "Gastos pessoais", sheet: "👤 Gastos pessoais" },
  { code: 6, label: "Saúde e bem-estar", sheet: "🩺 Saúde e bem-estar" },
  { code: 7, label: "Presentes", sheet: "🎁 Presentes" },
  { code: 8, label: "Pets", sheet: "🐾 Pets" },
  { code: 9, label: "Moradia", sheet: "🏠 Moradia" },
  { code: 10, label: "Assinaturas", sheet: "🗂️ Assinaturas" },
  { code: 11, label: "Serviços domésticos", sheet: "🧹 Serviços domésticos" },
  { code: 12, label: "Parcelamentos", sheet: "💳 Parcelamentos" },
  { code: 13, label: "Mensalidades", sheet: "🪙 Mensalidades" },
  { code: 14, label: "Outros", sheet: "🧾 Outros" },
]


const PAYMENTS = [
  { code: 1, label: "Dinheiro", sheet: "💸 Dinheiro / Pix" },
  { code: 2, label: "Pix", sheet: "💸 Dinheiro / Pix" },
  { code: 3, label: "Crédito", sheet: "💳 Crédito" },
  { code: 4, label: "Débito", sheet: "💳 Débito" },
  { code: 5, label: "Vale", sheet: "🎟️ Vale" },
  { code: 6, label: "Boleto", sheet: "💲 Boleto" },
]


class Invoice {
  constructor() {
    this.date = undefined
    this.value = undefined
    this.categoryCode = undefined
    this.categoryLabel = undefined
    this.category = undefined
    this.paymentCode = undefined
    this.paymentLabel = undefined
    this.transferenceType = undefined
    this.description = undefined
    this.essential = undefined
  }
}


const userState = new Map()

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function buildCategoryKeyboard() {
  const rows = chunk(
    CATEGORIES.map(c => Markup.button.callback(`${c.sheet}`, `cat:${c.code}`)),
    2
  )
  return Markup.inlineKeyboard(rows)
}

function buildPaymentKeyboard() {
  const rows = chunk(
    PAYMENTS.map(p => Markup.button.callback(`${p.sheet}`, `pay:${p.code}`)),
    2
  )
  return Markup.inlineKeyboard(rows)
}

function buildEssentialKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✔️ Essencial", "ess:yes"), Markup.button.callback("❌ Não essencial", "ess:no")]
  ])
}

async function authSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: process.env.GOOGLE_TYPE,
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
      auth_uri: process.env.GOOGLE_AUTH_URI,
      token_uri: process.env.GOOGLE_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
      universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
  const client = await auth.getClient()
  return google.sheets({ version: "v4", auth: client })
}

async function writeRange(range, values) {
  const sheets = await authSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  })
}

async function downloadFile(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId)
  const url = typeof fileLink === "string" ? fileLink : fileLink.href
  const res = await axios.get(url, { responseType: "arraybuffer" })
  return res.data
}

async function getNextEmptyRow() {
  const sheets = await authSheets()
  const startRow = 22

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET,
    range: "JANEIRO!M22:O",
  })

  const rows = res.data.values || []
  let lastUsedIndex = -1

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || []
    const hasAnyValue = row.some(cell => cell && cell.toString().trim() !== "")
    if (hasAnyValue) lastUsedIndex = i
  }

  if (lastUsedIndex === -1) return startRow
  return startRow + lastUsedIndex + 1
}

async function extractTextFromPdf(buffer) {
  const data = await pdf(buffer)
  return data.text
}

async function parseInvoiceFromText(text) {
  console.log(text)
  const invoice = new Invoice()

  const valorMatch = text.match(/Valor\s+R\$\s*([\d.,]+)/i)
  const dataMatch = text.match(/\b(\d{2})\s+([A-ZÇÃÕ]{3})\s+(\d{4})\b/i)

  if (valorMatch) invoice.value = valorMatch[1].trim()

  if (dataMatch) {
    const dia = dataMatch[1]
    const mesAbrev = dataMatch[2].toUpperCase()
    const ano = dataMatch[3]
    const mesNum = Meses[mesAbrev]
    if (mesNum) invoice.date = `${dia}/${mesNum}/${ano}`
  }

  return invoice
}

async function extractTextFromImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng", { logger: () => { } })
  return result.data.text
}

function formatInvoicePreview(invoice) {
  const v = invoice.value ? `R$ ${invoice.value}` : "não encontrado"
  const d = invoice.date ? invoice.date : "não encontrada"
  return `Achei isso na nota:\nValor: ${v}\nData: ${d}\n\nAgora escolha a categoria:`
}

async function persistInvoice(invoice) {
  const nextRow = await getNextEmptyRow()
  const descToWrite = invoice.description ?? ""

  await writeRange(`JANEIRO!M${nextRow}`, [[invoice.value ?? ""]])
  await writeRange(`JANEIRO!N${nextRow}`, [[invoice.date ?? ""]])
  await writeRange(`JANEIRO!P${nextRow}`, [[invoice.transferenceType ?? ""]])
  await writeRange(`JANEIRO!O${nextRow}`, [[invoice.category ?? ""]])
  await writeRange(`JANEIRO!L${nextRow}`, [[descToWrite]])
  await writeRange(`JANEIRO!Q${nextRow}`, [[invoice.essential ?? ""]])

}

async function startCategoryFlow(ctx, invoice) {
  userState.set(ctx.from.id, { step: "category", invoice })
  await ctx.reply(formatInvoicePreview(invoice), buildCategoryKeyboard())
}

bot.start(async ctx => {
  if (!isAllowed(ctx)) return ctx.reply("Acesso restrito.")
  await ctx.reply("Manda a nota fiscal em PDF ou PNG como arquivo que eu leio para você.")
})

bot.on("document", async ctx => {
  if (!isAllowed(ctx)) return ctx.reply("Acesso restrito.")
  try {
    const doc = ctx.message.document
    if (!doc) return ctx.reply("Não consegui ver o arquivo.")

    const mime = doc.mime_type || ""
    const buffer = await downloadFile(ctx, doc.file_id)

    let text = ""
    if (mime === "application/pdf") {
      text = await extractTextFromPdf(buffer)
    } else if (mime.startsWith("image/")) {
      text = await extractTextFromImage(buffer)
    } else {
      return ctx.reply("Me manda a nota como PDF ou imagem (PNG/JPEG).")
    }

    const invoice = await parseInvoiceFromText(text)
    await startCategoryFlow(ctx, invoice)
  } catch (e) {
    console.error("Erro ao processar documento:", e)
    await ctx.reply("Deu erro ao ler o arquivo.")
  }
})

bot.on("photo", async ctx => {
  if (!isAllowed(ctx)) return ctx.reply("Acesso restrito.")
  try {
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const buffer = await downloadFile(ctx, largest.file_id)
    const text = await extractTextFromImage(buffer)
    const invoice = await parseInvoiceFromText(text)
    await startCategoryFlow(ctx, invoice)
  } catch (e) {
    console.error("Erro ao processar imagem:", e)
    await ctx.reply("Deu erro ao ler a imagem.")
  }
})

bot.action(/^cat:(\d+)$/, async ctx => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery()
  try {
    await ctx.answerCbQuery()
    const state = userState.get(ctx.from.id)
    if (!state || !state.invoice) return ctx.reply("Não encontrei uma nota em andamento. Manda a nota novamente.")

    const code = Number(ctx.match[1])
    const cat = CATEGORIES.find(c => c.code === code)

    state.invoice.categoryCode = code
    state.invoice.categoryLabel = cat ? cat.label : undefined
    state.invoice.category = cat ? cat.sheet : ""

    state.step = "payment"
    userState.set(ctx.from.id, state)

    await ctx.reply(`Categoria selecionada: ${cat ? cat.sheet : code}\n\nAgora escolha a forma de pagamento:`, buildPaymentKeyboard())
  } catch (e) {
    console.error(e)
    await ctx.reply("Deu erro ao selecionar a categoria.")
  }
})

bot.action(/^pay:(\d+)$/, async ctx => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery()
  try {
    await ctx.answerCbQuery()
    const state = userState.get(ctx.from.id)
    if (!state || !state.invoice) return ctx.reply("Não encontrei uma nota em andamento. Manda a nota novamente.")

    const code = Number(ctx.match[1])
    const pay = PAYMENTS.find(p => p.code === code)

    state.invoice.paymentCode = code
    state.invoice.paymentLabel = pay ? pay.label : undefined
    state.invoice.transferenceType = pay ? pay.sheet : ""

    state.step = "essential"
    userState.set(ctx.from.id, state)
    await ctx.reply(`Forma selecionada: ${pay ? pay.sheet : code}\n\nA compra foi essencial?`, buildEssentialKeyboard())

  } catch (e) {
    console.error(e)
    await ctx.reply("Deu erro ao selecionar a forma de pagamento.")
  }
})

bot.action(/^ess:(yes|no)$/, async ctx => {
  if (!isAllowed(ctx)) return ctx.answerCbQuery()
  try {
    await ctx.answerCbQuery()
    const state = userState.get(ctx.from.id)
    if (!state || !state.invoice) return ctx.reply("Não encontrei uma nota em andamento. Manda a nota novamente.")

    const val = ctx.match[1] === "yes" ? "✔️" : "❌"
    state.invoice.essential = val

    state.step = "description"
    userState.set(ctx.from.id, state)

    await ctx.reply(`Marcado: ${val}\n\nDigite uma descrição da nota fiscal (ou mande /pular):`)
  } catch (e) {
    console.error(e)
    await ctx.reply("Deu erro ao marcar essencial.")
  }
})


bot.on("text", async ctx => {
  if (!isAllowed(ctx)) return ctx.reply("Acesso restrito.")
  const state = userState.get(ctx.from.id)

  if (state?.step === "description") {
    const msg = (ctx.message.text || "").trim()
    if (msg.toLowerCase() === "/pular") state.invoice.description = ""
    else state.invoice.description = msg

    try {
      await persistInvoice(state.invoice)
      userState.delete(ctx.from.id)
      await ctx.reply("Fechado. Salvei no Google Sheets.")
    } catch (e) {
      console.error(e)
      await ctx.reply("Deu erro ao salvar no Google Sheets.")
    }
    return
  }

  await ctx.reply("Manda a nota fiscal como PDF ou PNG/JPEG para eu processar.")
})

bot.on("message", async ctx => {
  const state = userState.get(ctx.from.id)
  if (state?.step) return
  await ctx.reply("Manda a nota fiscal como PDF ou PNG/JPEG para eu processar.")
})


if (domain) {
  bot.launch({
    webhook: {
      domain,
      hookPath,
      port,
      secretToken: process.env.WEBHOOK_SECRET,
    },
  })
} else {
  bot.launch()
}

process.once("SIGINT", () => bot.stop("SIGINT"))
process.once("SIGTERM", () => bot.stop("SIGTERM"))
