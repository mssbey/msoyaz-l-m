# MSO Teknoloji — Merkezi Pazar Yeri Fiyatlama ve WMS Sistemi

Spesifikasyon V1.0'in calisir implementasyonu: fiyatlandirma motoru, WMS (barkod) modulu,
Sentos entegrasyon katmani (kuyruk tabanli), CRON gorevleri ve yonetim paneli + depo terminali.

## Mimari

```
                    ┌─────────────────┐        ┌──────────────┐
  Yonetim Paneli ──▶│                 │───────▶│  PostgreSQL  │
  (Vue 3 SPA)       │   API (Express) │        └──────────────┘
                    │                 │              ▲
  Depo Terminali ──▶│  - fiyat motoru │              │
  (PWA)             │  - WMS          │        ┌──────────────┐
                    │  - webhook ucu  │───────▶│    Redis     │
  Sentos webhook ──▶│                 │  job   │  (BullMQ)    │
                    └─────────────────┘        └──────────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │ Worker sureci  │──▶ Sentos API
                                              │ + CRON         │    (rate limit)
                                              └────────────────┘
```

API sureci hicbir agir isi kendisi yapmaz; hesaplama ve dis API cagrilari Redis kuyruguna
alinir, ayri bir worker sureci bunlari Sentos'un kabul edecegi hizda isler.

## Kurulum

### 1. Altyapi (PostgreSQL + Redis)

```bash
docker compose up -d
```

Postgres `localhost:5438`, Redis `localhost:6381` uzerinde acilir.

### 2. Backend

```bash
cd backend && npm install && cp .env.example .env && npx prisma db push && npm run seed
```

Iki surec ayri terminalde calisir:

```bash
npm run dev
```

```bash
npm run worker
```

`npm run dev` API'yi (http://localhost:4000), `npm run worker` kuyruk isleyicilerini ve CRON gorevlerini baslatir.

### 3. Frontend

```bash
cd frontend && npm install && npm run dev
```

- Yonetim paneli: http://localhost:5173/panel
- Depo terminali: http://localhost:5173/terminal

### Kullanıcı adı ve şifreyle giriş

Backend klasöründe `npm run auth:setup` çalıştırın. Varsayılan kullanıcı adı `admin`;
PowerShell'de `$env:MSO_SETUP_USERNAME='msoteknoloji'` ile değiştirilebilir.
Komut rastgele bir şifre üretir, yalnızca scrypt hash'ini `backend/.env` içine yazar.
Kullanıcı adı ve şifre proje kökündeki `GIRIS-BILGILERI.local.txt` dosyasındadır;
bu dosya Git kapsamı dışındadır. Bilgileri güvenli bir yere aldıktan sonra dosyayı kaldırabilirsiniz.
API'yi yeniden başlatın ve http://localhost:5173 adresinden giriş yapın.

Tek yönetici hesabıyla paneldeki tüm operasyonlar ve barkod terminali açılır.
Tarayıcıya API anahtarı girilmez. HttpOnly / SameSite=Strict oturum çerezi kullanılır;
oturum Redis'te tutulur ve varsayılan 12 saat sonra sona erer (`SESSION_HOURS`).
Çıkış yapmak sunucu oturumunu da iptal eder. Yanlış giriş denemeleri IP bazında sınırlandırılır.
Stok işlemlerindeki operatör giriş yapan kullanıcıdan alınır.

Şifreyi yenilemek için backend klasöründe `npm run auth:setup -- --reset` çalıştırın,
API'yi yeniden başlatın. Yeni şifre aynı yerel dosyaya yazılır; önceki oturumlar geçersiz olur.
Bu sürüm tek yönetici hesabı kullanır; çoklu kullanıcı yönetimi içermez.
Üretimde `NODE_ENV=production` ve HTTPS kullanın; üretim çerezi `Secure` olarak ayarlanır.
Ön yüz ve API'yi aynı origin altında (`/api` ters proxy) yayınlayın.

Doğrulama: `npm run test:auth` (backend klasöründe, Redis çalışırken).

## Fiyatlandirma motoru

`backend/src/modules/pricing/pricing.engine.ts` — yan etkisi olmayan saf fonksiyon.
Tum para islemleri `decimal.js` ile yapilir (kayan nokta hatasi yok).

Motor **iki model** destekler; hangisinin kullanilacagi `settings.pricing_model` ile secilir.

### 1) `EXCEL_MARKUP` (varsayilan) — "Tam Liste" calisma kitabinin birebir karsiligi

Calisma kitabindaki formuller cozumlenerek koda alinmistir. Komisyon **tersine bolme ile
degil, carpan olarak** uygulanir:

```
Maliyet ($)      L = alis + gumruk (+ navlun)
Maliyet (TL)     N = alis > 0 ? L x kur : 0
Hedef fiyat      P = L > 0 ? N x (1 + karlilik) + paketleme : 0
Kargo testi      C = P x (1 + extraFark) x (b+R) x (b+T) x (b+V)      b = 1.019
Kargo            K = (C + altKargo) < barem ? altKargo : ustKargo
Satis fiyati     X = (P + K) x (1 + extraFark) x (1+R) x (1+T) x (1+V)
Piyasa fiyati        X x (1 + piyasaFarki)                            TY / PZRM
Hakedis          Z = (P + K) x (1 + extraFark) x (1+R) - K
eNyeniler        AV = P x (1 + enyFark) / (1 + enyIndirim) x (1.018 + R)
```

`R` = "% Extra ilave", `T` = komisyon, `V` = ek komisyon (varyant bazinda tutulur).
Excel'in `IF(NUMBERVALUE(...))` korumalari da birebir uygulanir: alis fiyati bos olan
satirlarda maliyet 0, hedef fiyat yalnizca paketleme gideri kadar olur.

### 2) `REVERSE_COMMISSION` — Spesifikasyon V1.0

1. Taban maliyet (TL) = (alis + gumruk + navlun) x kur
2. Hedef gelir = maliyet + (maliyet x kar marji %) + (maliyet x fire %)
3. Kargo baremi: hedef gelir > barem ise satici kargoyu oder
4. Fiyat = (hedef gelir + kargo) / (1 - toplam komisyon / 100)

> **Not:** Spesifikasyon V1.0'daki tersine komisyon formulu ile calisma kitabinin kullandigi
> carpan formulu ayni sonucu vermez. Excel'deki fiyatlarin korunmasi icin varsayilan
> `EXCEL_MARKUP`'tir; V1.0 modeli Ayarlar ekranindan tek tikla secilebilir.

Testler: `cd backend && npm run test:pricing` (14 senaryo; EXCEL_MARKUP beklentileri gercek
calisma kitabi satirlarindan alinmistir).

### Observer (tetikleyici)

`settings` tablosunda kur, karlilik, paketleme, barem, kargo veya yuvarlama degistiginde
`updateSettings` otomatik olarak toplu yeniden hesaplama isini kuyruga birakir
(`backend/src/modules/settings/settings.service.ts`). Ayni sey komisyon degisiminde ve
varyantin maliyet alanlari degistiginde de olur. Hesaplama bittiginde degisen fiyatlar
`PENDING` isaretlenir ve Sentos aktarim kuyruguna alinir.

## WMS akisi

- Terminal ekrani tek bir input alanidir; el okuyucu barkodu yazip Enter gonderir (native form submit).
- `POST /api/wms/scan` → `product_variants.barcode` (veya varyant kodu / Sentos stok kodu) aranir.
- Eslesme varsa urun adi ve kalan stok buyuk punto gosterilir, WebAudio ile "BIP" sesi calar,
  cihaz destekliyorsa titresim verilir. Hatada farkli (kalin) uyari sesi calar.
- Stok dususu ve hareket kaydi tek transaction icindedir; kosullu update sayesinde iki terminal
  ayni anda okutsa bile stok eksiye dusmez.
- Ayni islemde Sentos stok senkronizasyon kuyruguna is birakilir.

### Rezervasyon mantigi (spesifikasyondan sapma — bilinçli)

Spesifikasyon "webhook geldiginde `stock_quantity` dusulsun (dijital rezerv)" diyor. Bu haliyle
ayni siparis iki kez dusulur: once webhook, sonra raftan okutuldugunda. Bunun yerine:

- Webhook → `reserved_quantity` artar. Satilabilir stok (`stock_quantity − reserved_quantity`)
  aninda azalir ve pazar yerlerine bu deger gonderilir; yani istenen etki (aninda rezerv) korunur.
- Raftan okutma → `stock_quantity` duser ve varsa rezervasyon tuketilir.

Fiziksel stok ile satilabilir stok ayri tutuldugu icin cift dusum olmaz. Aksi istenirse
`wms.service.ts` icindeki `reserveForOrder` tek noktadan degistirilebilir.

## Sentos entegrasyonu

Resmi dokuman: https://api.sentos.com.tr/docs (v1.5). Kimlik dogrulama **Basic Auth**:
kullanici = panel "API Anahtar", sifre = "API Sifre", adres = "API Url" (`.env`).

> **Temel kural: Sentos'a asla yazilmaz.** Yazilim Sentos'tan yalnizca veri okur ve ceker.
> `sentos.client.ts` icindeki `SENTOS_READ_ONLY` sabiti GET disindaki her istegi ag katmanina
> ulasmadan engeller ve `SKIPPED` olarak loglar. Bu bir ortam degiskeni degildir; `SENTOS_DRY_RUN`
> veya `SENTOS_PRICE_PUSH_ENABLED` ne olursa olsun yazma gitmez.

**Stogun dogru kaynagi Sentos'tur** (pazar yeri satislari orada dusulur):

- **Urun cekme**: `GET /products` sayfa sayfa okunur; urun, varyant, barkod, renk/beden, gorsel
  ve depo bazli stok lokale aktarilir (`sentos-sync.service.ts`). Eslestirme: Sentos urun ID ->
  SKU -> barkod. Maliyet/komisyon alanlarina dokunulmaz. Her 15 dk + panelden "Urunleri Sentos'tan Cek".
- **Okutma**: yalnizca lokal stogu duser. Salt okunur kural geregi Sentos'a iletilmez; bekleyen fark
  temizlenir ve lokal stok bir sonraki urun senkronunda Sentos'taki degere doner.
- **Siparisler**: `GET /orders` ile 2 dakikada bir cekilir (`orders-sync.service.ts`) ve
  `sentos_orders` / `sentos_order_lines` tablolarina kopyalanir. Ilk calismada son
  `SENTOS_ORDER_BACKFILL_DAYS` (vars. 30) gun, sonrasinda imlecten itibaren olusan ve guncellenen
  siparisler okunur; durum degisiklikleri (onay, kargo, iptal, teslim) guncellenir. Satirlar lokal
  varyantlarla SKU -> barkod sirasiyla eslestirilir. Siparis cekme stok degistirmez (Sentos stogu
  zaten dusurur, urun senkronu onu getirir). Panel: **Siparisler**.
- **Depo**: dusus panelde secilen "Cikis Deposu"ndan yapilir; yetmezse en cok stogu olan diger
  depodan tamamlanir. Toplam stok eksiye dusmez.
- **Limit**: Sentos POST 12/dk, ayni GET 2/dk. `SENTOS_REQUESTS_PER_MINUTE` (vars. 10) asilmaz.
- **Hata**: 429/5xx/ag hatalari tekrar denenir; kalici hatalar varyanta yazilir ve panelde
  "Sentos'a Iletilemeyen Stok Dususleri" tablosunda gorunur ("Tekrar Dene" ile yeniden gonderilir).
  Iletilemeyen farklar her dakika CRON ile taranir.
- **Deneme modu**: `SENTOS_DRY_RUN=true` iken urunler Sentos'tan **cekilir**, ancak hicbir yazma
  istegi gitmez. Canliya almak icin `false` yapip API ve worker'i yeniden baslatin.
- **Fiyat aktarimi** henuz Sentos'un gercek fiyat alanina baglanmadi; `SENTOS_PRICE_PUSH_ENABLED=false`
  iken yalnizca loglanir.
- **Webhook ucu**: `POST /api/webhooks/sentos/orders` (HMAC-SHA256). Siparis Sentos'ta zaten
  stoktan dustugu icin webhook yalnizca lokal rezervasyon yapar, Sentos'a geri yazmaz.
- **Denetim izi**: her istek `sentos_sync_logs` tablosuna yazilir (panel: "Sentos Entegrasyonu").

### Depo terminali akisi

- **Hizli cikis**: barkod okutulur -> stok duser.
- **Urun secerek cikis**: sagdaki listeden urun aranip secilir, sonra barkodu okutulur. Okutulan
  barkod secili urune ait degilse stok dusmez ve hata sesi calar. Etiket okunmuyorsa "Barkodsuz Dus".
- Adet alani ile ayni urunden birden fazla cikis tek okutmada yapilabilir.

Testler: `cd backend && npm run test:sentos` · `npm run test:orders`

## CRON gorevleri

Worker surecinde calisir (`backend/src/cron/scheduler.ts`), saat dilimi `Europe/Istanbul`:

| Saat | Gorev |
|---|---|
| 03:00 | TCMB `today.xml` uzerinden USD satis kuru cekilir |
| 03:10 | Tum aktif varyantlarin pazar yeri fiyatlari yeniden hesaplanir |
| 03:30 | Degisen fiyatlar Sentos aktarim kuyruguna alinir |
| Her 15 dk | Sentos'tan urun + stok cekme (Sentos dogru kabul edilir) |
| Her 2 dk | Sentos'tan yeni/guncellenen siparislerin cekilmesi (`CRON_ORDER_SYNC`) |
| Her dakika | Bekleyen okutma farklarinin temizlenmesi (Sentos'a yazilmaz) |

Zamanlar `.env` icinden degistirilebilir; `CRON_ENABLED=false` ile tumu kapatilir.

## API uclari

Panel ve terminal uçları oturum çereziyle korunur. Oturumla yapılan yazma istekleri
`x-mso-client: web` başlığı bekler. Entegrasyon istemcileri için mevcut `x-api-key`
desteği korunur (`ADMIN_API_KEY` / `TERMINAL_API_KEY`). Webhook HMAC imzasıyla doğrulanır.

- `POST /api/auth/login`: `{ "username": "...", "password": "..." }`
- `GET /api/auth/me`: geçerli kullanıcı ve rol
- `POST /api/auth/logout`: oturumu iptal et

| Metot | Uc | Aciklama |
|---|---|---|
| GET | `/health` | DB + Redis saglik kontrolu |
| GET/PUT | `/api/settings` | Global ayarlar (PUT observer'i tetikler) |
| POST | `/api/settings/exchange-rate/sync` | TCMB kurunu simdi cek |
| GET/POST/PUT | `/api/products` | Ana urunler |
| GET/POST/PUT | `/api/variants` | Varyantlar (SKU) |
| PATCH | `/api/variants/:id/stock` | Elle stok duzeltme |
| GET/POST/PUT/DELETE | `/api/commissions` | Varsayilan pazar yeri komisyonlari |
| GET/PUT | `/api/marketplace-settings` | Kargo baremi, extra fark, piyasa fiyati carpani |
| POST | `/api/pricing/simulate` | Kaydetmeden hesaplama (panelde reaktif) |
| GET | `/api/pricing/preview/:variantId` | Varyantin tum pazar yeri kirilimi |
| POST | `/api/pricing/recalculate` | Toplu yeniden hesaplama (kuyruk) |
| POST | `/api/pricing/push` | Bekleyen fiyatlari Sentos kuyruguna al |
| GET | `/api/pricing/status` | Fiyat + kuyruk durumu |
| GET | `/api/wms/lookup?barcode=` | Barkod sorgulama (stok dusurmez) |
| POST | `/api/wms/scan` | Depo cikisi (stok −1) |
| GET | `/api/wms/movements` | Stok hareketleri |
| GET | `/api/sentos/logs` · `/api/sentos/webhooks` | Senkronizasyon denetim izi |
| GET | `/api/sentos/status` | Entegrasyon durumu |
| POST | `/api/sentos/sync-products` | Sentos'tan urun + stok cek |
| GET/PUT | `/api/sentos/warehouses` · `/api/sentos/warehouse` | Depolar / cikis deposu |
| POST | `/api/sentos/retry-stock` | Hatali stok aktarimlarini tekrar dene |
| GET | `/api/wms/search?q=` | Terminalde urun arama |
| GET | `/api/orders` | Siparisler (q, status, source, from, to, unmatched, page) |
| GET | `/api/orders/summary` | Durum / pazar yeri kirilimi, bugunun ozeti, son senkron |
| GET | `/api/orders/:id` | Siparis detayi + satirlar + lokal urun eslesmesi |
| POST | `/api/orders/sync` | Sentos'tan siparisleri simdi cek (`{ "full": true }` = son N gunu yeniden oku) |
| POST | `/api/webhooks/sentos/orders` | Sentos siparis webhook'u (HMAC imzali) |

## Veritabani

`backend/prisma/schema.prisma` — 3NF normalize, 9 tablo:
`settings`, `products`, `product_variants`, `marketplace_commissions`, `marketplace_settings`,
`variant_prices`, `stock_movements`, `sentos_sync_logs`, `webhook_events`.

Kanallar: `STD`, `N11`, `HB`, `TY`, `PZRM`, `ENY` (eNyeniler). Her varyant icin 6 fiyat
satiri uretilir (808 varyant × 6 = 4848 satir).

`variant_prices` turetilmis veridir (hesap sonucu onbellegi) ve her zaman motordan yeniden
uretilebilir; `stock_movements` ise degistirilmez denetim izidir.

## Excel aktarimi

```bash
cd backend && npm run import -- "C:/Users/PC/Desktop/Tam Liste-27.xlsx"
```

Secenekler: `--dry-run` (yalnizca rapor), `--no-verify` (dogrulamayi atla),
`--deactivate-missing` (dosyada olmayan varyantlari pasife ceker).

Sayfa eslesmeleri:

| Excel sayfasi | Hedef |
|---|---|
| **MSO Ayarlar** | `settings` + `marketplace_settings` (etiketlere gore okunur, konuma bagli degil) |
| **MSO Liste** | `products` (ana urun kodu bazinda) + `product_variants` (barkod, maliyet, komisyon, stok) |
| **MSO Resimler** | `product_variants.image_url` |
| **MSO Hesaplamalar / MSO to Sentos Transfer** | Motorun urettigi `variant_prices` satirlari |

Aktarim sonunda tum fiyatlar yeniden hesaplanir ve **Excel'in kendi sonuc kolonlariyla
karsilastirilir**. Son calistirmanin ciktisi:

```
MSO Liste: 808 varyant satiri okundu.
Ana urun sayisi: 247        Toplam stok adedi: 30727
808 varyant islendi, 4848 fiyat yazildi.

Dogrulama: 8888 deger karsilastirildi
  STD / N11 / HB / TY / PZRM  maks fark: 5.0e-7
  TY_MARKET / PZRM_MARKET     maks fark: 5.0e-7
  TARGET / COST_TRY / PAYOUT  maks fark: 1.8e-12
  Tum fiyatlar Excel ile birebir ortusuyor.
```

Kalan ~5×10⁻⁷ TL'lik fark, fiyatlarin veritabaninda 6 ondalikla saklanmasindan gelir.

### Aktarilan veriden notlar

- Komisyon oranlari calisma kitabinda **varyant bazindadir** (%16 + %3.451); bu yuzden
  `product_variants.commission_percent` alanlarina yazilir. `marketplace_commissions`
  tablosu yalnizca varyantta deger yoksa devreye giren yedek tanimdir.
- 15 varyantin alis fiyati bostur (yalnizca gumruk girilmis). Excel bu satirlarda maliyeti
  0 kabul ettigi icin sistem de ayni sonucu uretir — fiyatlari yalnizca paketleme gideri
  uzerinden olusur. Bu satirlarin maliyetleri panelden tamamlanmalidir.
- Marka alaninda yazim farklari var ("MSO Teknoloji" / "Mso Teknoloji" / "MSOTeknoloji").
  Veri oldugu gibi aktarilmistir; istenirse tek biçime cekilebilir.
- "MSO Stok" sayfasindaki SENTOS kolonlari (D/E) magaza stok kodlariyla birebir eslesmedigi
  icin stok, sayfanin "Magaza Stok/Adet" degerlerinden alinmistir. Canli stok zaten
  15 dakikalik mutabakat dongusuyle Sentos'tan tazelenir.

## Uretim notlari

- `SENTOS_DRY_RUN=false` yapmadan once `SENTOS_API_KEY`, `SENTOS_API_SECRET` ve gercek
  endpoint yollari doldurulmalidir.
- Giriş hesabını `npm run auth:setup` ile kurun. Şifre hash olarak saklanır; oturumlar Redis üzerinden doğrulanır.
- `npm run build` ile TypeScript derlenir; `npm start` ve `npm run start:worker` uretim komutlaridir.
- Frontend `npm run build` ciktisi (`frontend/dist`) statik olarak yayinlanir; PWA service worker
  yalnizca uretim derlemesinde aktiftir.
