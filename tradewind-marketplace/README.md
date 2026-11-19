# TradeWind Co. — Global B2B Buyer & Supplier Marketplace

*By Crescendo Worldwide.* This is a working, database-driven marketplace. Buyers post requirements and RFQs. Suppliers list products and stock. A matching engine sends each RFQ to the best-fit suppliers. Suppliers submit quotations, and buyers compare them and award the order. An admin team verifies companies and screens requirements and quotes.

---

## 1. Run it on your own computer (about 10 minutes)

**Step 1: Install Node.js.**
Download the **LTS** version (v22 or newer) from https://nodejs.org and install it with the default options.
To check it worked, open a terminal (on Windows: press Start, type `cmd`, press Enter) and run `node -v`. You should see `v22…` or `v24…`.

**Step 2: Unzip the project.**
Unzip `tradewind-marketplace.zip`, for example to `C:\tradewind`. Then go into that folder in the terminal:

```
cd C:\tradewind
```

**Step 3: Install the libraries.** You only need to do this once.

```
npm install
```

**Step 4 (optional): Load the demo data.**
This adds sample buyers, suppliers, products, RFQs, quotes and messages.

```
npm run seed
```

**Step 5: Start the website.**

```
npm start
```

Then open **http://localhost:3000** in your browser.

### Logins

| Role | Email | Password |
|---|---|---|
| Admin (Crescendo team) | admin@tradewind.local | Admin@12345 |
| Demo buyer | buyer@demo.com | Demo@1234 |
| Demo supplier | supplier@demo.com | Demo@1234 |
| Confidential-sourcing buyer | buyer2@demo.com | Demo@1234 |
| Supplier with an NDA to sign | supplier2@demo.com | Demo@1234 |

You can also register brand-new companies from the **Register** page.

To wipe everything and start with an empty database, run `npm run reset`. Run `npm run seed` afterwards if you want the demo data back.

---

## 2. Put it on the internet with your own domain

The site needs a server that runs Node.js and keeps files on disk. Static hosts such as GoDaddy shared hosting, Wix or plain Netlify won't work.

Each option below runs the code exactly as it is.

### Option A: Railway (easiest, about ₹400–800 a month)

1. Create a free account at https://github.com and upload this folder as a new **private** repository. Use "Add file → Upload files". Don't upload `node_modules`, `data` or `.env`.
2. Go to https://railway.app, sign in with GitHub, then choose **New Project → Deploy from GitHub repo** and pick your repository.
3. Open the service and go to **Variables**. Add these:
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = any long random text
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` = your real admin login
   - `DATA_DIR` = `/data/db` and `UPLOAD_DIR` = `/data/uploads`
4. Go to **Settings → Volumes → Add volume** and set the mount path to `/data`. This keeps your database and uploads safe between deploys.
5. Go to **Settings → Networking → Generate domain**. You now have a public link, for example `tradewind-production.up.railway.app`.
6. To use your own domain, go to **Settings → Networking → Custom domain** and enter `www.yourdomain.com`. Railway shows a CNAME record. Add that record in your domain registrar's DNS settings (GoDaddy, Hostinger, Namecheap, etc.). HTTPS is set up automatically.

Render.com works the same way. Use a "Web Service" plus a "Persistent Disk" mounted at `/data`. A disk needs a paid plan.

### Option B: Your own VPS (Hostinger, DigitalOcean, AWS Lightsail, about ₹400–1,000 a month)

On an Ubuntu 22.04 or 24.04 server, run:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs nginx
# upload the project to /var/www/tradewind (SFTP, WinSCP, or git clone)
cd /var/www/tradewind && npm install --omit=dev && cp .env.example .env && nano .env
sudo npm i -g pm2 && pm2 start npm --name tradewind -- start && pm2 save && pm2 startup
```

Then point your domain's **A record** to the server's IP address. Set up Nginx to pass `yourdomain.com` to `http://localhost:3000`. Add free HTTPS with `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx`.

> If you test over plain `http://` (no HTTPS yet) with `NODE_ENV=production`, add `INSECURE_COOKIE=1` to `.env`. Without it, login won't work. Remove it once HTTPS is on.

### Option C: Docker

```
docker build -t tradewind . && docker run -d -p 3000:3000 -v tradewind-data:/data --env-file .env tradewind
```

---

## 3. What's included (all working)

| Module | Features |
|---|---|
| **Registration & roles** | Buyer, supplier (manufacturer, trader, distributor or stockist) or both. Secure password hashing, sessions, CSRF protection and a login rate-limit. Admin role. |
| **Company profiles** | Registration number, tax ID, address, website, industries, capabilities, production capacity, certifications and logo. Profile-completeness meter and trust score. |
| **Verification (KYB)** | Upload a registration document, admin approves or rejects, Verified badge. Changing legal details triggers re-verification. |
| **Products & stock** | Category, material, grade, specifications, ready stock or made to order, stock quantity, MOQ, price, currency, lead time, Incoterm, image and datasheet. Quick stock update. |
| **Search** | Products or suppliers by keyword, industry, category, country, ready stock and verified status. Featured and premium listings rank first. |
| **Requirements / RFQs** | Full specification, quantity, target price, Incoterm, delivery port, dates and drawings (stored privately). **Confidential mode** hides the buyer's identity and drawings until shortlisting. |
| **Matching engine** (`lib/matching.js`) | Scores suppliers 0–100 on category, keywords, material, grade, stock against quantity, MOQ, capability, country and verification. Sends the RFQ to the top 15 on approval and shows reasons. Buyers can invite more suppliers. |
| **Quotations** | Unit price, currency, MOQ, lead time, payment terms, Incoterm, validity, notes and file. Optional admin check before release. Shortlist, reject or award. **Side-by-side comparison** highlights the lowest price, fastest lead time and best trust score. |
| **Messaging** | Conversations linked to an RFQ or product. Emails and phone numbers are masked until a deal is awarded, which keeps business on the platform. |
| **Notifications** | In-app alerts for matches, quotes, awards, verification and messages. |
| **Dashboards** | Buyer: requirements, quotes and saved suppliers. Supplier: products, stock, matched RFQs, quotes, wins and views. |
| **Admin panel** | KPIs, work queue, company KYB, requirement screening with live match results, quote verification, product moderation, users, categories (13 industries pre-loaded), plans and featured flags, platform settings. |
| **🔒 Confidential sourcing (NDA-gated)** | A separate portal at `/confidential`. **1** The buyer shares only the basics, with no drawings: product, material and grade, weight, process, annual and batch quantity, target price, Incoterms, port and preferred countries. **2** TradeWind screens the request and proposes *verified* supplier profiles. Suppliers are told nothing. **3** The buyer shortlists. **4** The buyer's NDA is shared with the shortlist. The buyer can upload its own NDA or use the built-in mutual NDA. The supplier e-signs, with name, title, time and IP recorded, and can also upload a signed copy. The buyer countersigns, and the NDA is then "signed by both". **5** The buyer releases the full RFQ and the **secure drawing vault** to NDA-signed suppliers only. Vault files are view-only, watermarked per supplier, downloads are off by default, and every view is logged. Released suppliers then quote through the normal review, comparison and award flow. |
| **🤝 Virtual meetings** | Available once an RFQ is shared (for confidential RFQs, once the NDA is signed by both). The buyer or supplier picks the RFQ and counterpart, purpose, date and time, time zone, duration, alternative slot, and online or in-person. The flow is Requested → Accepted → Confirmed with a join link → Completed with minutes. Either side can propose a new time. One-click **Create on Zoom / Microsoft Teams / Google Meet** buttons open the platform (Teams and Google Calendar come pre-filled). Paste the link back to confirm. Includes **Join meeting** buttons, an **Add to calendar** (.ics) download, and times shown in each user's own time zone. Admins can coordinate every meeting at `/admin/meetings`. |
| **Monetisation hooks** | `plan` (free, premium or enterprise) and `featured` on companies and products drive ranking. Pricing page included. |

## 4. Updating a live site to a new version

1. On GitHub, open the `tradewind-marketplace` folder and click **Add file → Upload files**.
2. Drag in everything from the new unzipped `tradewind-marketplace` folder, then click **Commit changes**. Files with the same name are replaced.
3. Railway redeploys automatically in 1–3 minutes.

The database upgrades itself on start, so existing users, products and RFQs are kept.

## 5. Project structure

```
server.js            → app setup, security headers, sessions, routes
seed.js              → categories + admin (auto) and demo data (npm run seed)
lib/db.js            → database schema (SQLite built into Node) + helpers
lib/matching.js      → buyer–supplier matching & RFQ distribution
lib/helpers.js       → auth guards, CSRF, uploads, formatting, trust score
routes/              → public, auth, account, supplier, buyer (RFQ/quotes), confidential (NDA portal + vault), meetings, messages, admin
lib/tz.js            → time-zone conversion for meetings
seed-assets/         → sample drawing used by the demo data
views/               → EJS page templates (responsive)
public/              → CSS, JS, logo
data/ , uploads/     → created automatically: database + uploaded files (back these up!)
```

## 6. Next phases (roadmap)

1. **Email notifications.** Add SMTP (Amazon SES, SendGrid or Zoho) using nodemailer in `notifyCompany()`.
2. **Payments for memberships.** Use Razorpay or Stripe subscriptions to set `companies.plan` automatically.
3. **PostgreSQL** for scale. The schema in `lib/db.js` maps across almost one-to-one. Add S3 for uploads.
4. A negotiation room, PO, invoice and payment tracking, supplier audits. Optionally, DocuSign or Adobe Sign for legally stronger NDA e-signatures, and direct Zoom/Teams API integration to create meeting links automatically.
5. **AI agents.** RFQ analysis, quote comparison summaries and translation through the Claude API.
6. **Password reset email**, two-factor authentication, multi-user company teams, multiple languages.

Before launch: change the admin password, set `SESSION_SECRET`, enable HTTPS, back up `data/` and `uploads/` every day, and add your Terms and Privacy Policy pages. For Indian users this should cover the DPDP Act; for EU users, GDPR.
