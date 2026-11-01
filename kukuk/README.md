# Kukuk 👀

**Schvaľuj Claude Code z telefónu.** Keď Claude Code potrebuje povolenie (spustiť príkaz, upraviť súbor…), Kukuk ti pošle notifikáciu na telefón. Na **Androide** ju schváliš tlačidlom **✅ Povoliť / ⛔ Zamietnuť** priamo v notifikácii, aj na zamknutej obrazovke, a appku vôbec nemusíš otvárať.

- 📱 **Android** (Chrome): tlačidlá priamo v notifikácii, voliteľne potvrdenie odtlačkom prsta
- 🍏 **iPhone**: notifikácia → ťuk → Face ID (z web appky pridanej na plochu)
- 💻 **Mac**: systémová notifikácia a stav v lište (SwiftBar/xbar) s tlačidlami Povoliť/Zamietnuť
- 🔔 upozornenie, keď Claude **dokončí prácu** alebo **čaká na tvoju odpoveď**
- 🔐 párovanie jednorazovým kódom, tokeny sú uložené len v `~/.kukuk`, push správy sú šifrované end-to-end
- 0️⃣ **žiadne závislosti**, stačí Node.js 18+

## Ako to funguje

```
Claude Code ──hook──▶ Kukuk server (tvoj počítač) ──web push──▶ telefón
     ▲                         │                                   │
     └──── allow / deny ◀──────┴────────── Povoliť / Zamietnuť ◀───┘
```

Kukuk používa hook `PermissionRequest` v Claude Code. Ak telefón neodpovie, server nebeží alebo zvolíš „Rozhodnem v termináli“, Claude Code ti ukáže bežný dialóg v termináli. Nič sa nezasekne.

## Inštalácia (5 minút)

### 1. Spusti server na počítači

```bash
cd kukuk
node kukuk.js start          # vypíše 6-miestny párovací kód
node kukuk.js install        # pridá hooky do ~/.claude/settings.json (urobí zálohu)
```

Na Macu môžeš server spúšťať automaticky pri prihlásení: `node kukuk.js autostart`.

### 2. Sprístupni server telefónu cez HTTPS

Notifikácie v prehliadači vyžadujú HTTPS. Najjednoduchšie je **Tailscale** (zadarmo, funguje aj mimo domácej Wi-Fi):

1. Nainštaluj Tailscale na počítač aj na telefón ([tailscale.com/download](https://tailscale.com/download)) a prihlás sa rovnakým účtom.
2. V administrácii Tailscale zapni **HTTPS Certificates** (DNS → HTTPS).
3. Na počítači spusti:
   ```bash
   tailscale serve --bg 8787
   ```
   Vypíše adresu, napr. `https://moj-mac.tailnet-abc.ts.net`.

Alternatíva: Cloudflare Tunnel na vlastnej doméne (napr. `kukuk.nogrey.online`) s **Cloudflare Access**. Používaj stálu adresu, lebo notifikácie a odtlačok prsta sú viazané na doménu.

### 3. Spáruj telefón

1. Na telefóne otvor adresu z kroku 2 v **Chrome** (na iPhone v Safari, potom *Zdieľať → Pridať na plochu* a otvor Kukuk z plochy).
2. Zadaj párovací kód (nový vypíše `node kukuk.js pair`).
3. Ťukni **Zapnúť** pri notifikáciách.
4. *(Voliteľné)* Ťukni **Nastaviť** pri odtlačku prsta. Potom každé povolenie potvrdíš biometriou.

Hotovo. Reštartuj bežiace relácie `claude`, aby načítali hooky.

### Odtlačok prsta: áno, či nie?

| | Bez odtlačku | S odtlačkom prsta |
|---|---|---|
| **Povoliť** v notifikácii | schváli sa okamžite | otvorí Kukuk a vypýta odtlačok |
| **Zamietnuť** v notifikácii | okamžite | okamžite |
| Bezpečnosť | stačí ti mať odomknutý telefón | povoliť môžeš len ty |

## Lišta Macu (voliteľné)

Nainštaluj [SwiftBar](https://swiftbar.app) alebo [xbar](https://xbarapp.com) a spusti:

```bash
node kukuk.js menubar-install
```

V lište uvidíš `kukuk`, `kukuk ⋯` (Claude pracuje) alebo `👀 2` (2 požiadavky čakajú). V menu sú tlačidlá Povoliť / Vždy povoliť / Zamietnuť.

## Príkazy

| Príkaz | Čo robí |
|---|---|
| `node kukuk.js start` | spustí server |
| `node kukuk.js install [--project]` | pridá hooky globálne, alebo len pre aktuálny projekt (`.claude/settings.local.json`) |
| `node kukuk.js uninstall [--project]` | odstráni hooky (tvoje ostatné hooky ostanú) |
| `node kukuk.js pair` | nový párovací kód (platí 10 minút, max. 5 pokusov) |
| `node kukuk.js status` | stav servera, zariadení a relácií |
| `node kukuk.js menubar-install` | plugin do lišty Macu |
| `node kukuk.js autostart` | spúšťanie pri prihlásení (macOS) |
| `npm test` | testy |

## Nastavenia (premenné prostredia)

| Premenná | Predvolené | Význam |
|---|---|---|
| `KUKUK_PORT` | `8787` | port servera |
| `KUKUK_HOST` | `127.0.0.1` | adresa, na ktorej server počúva (pri Tailscale serve nechaj tak) |
| `KUKUK_WAIT` | `570` | koľko sekúnd hook čaká na telefón, potom ukáže dialóg v termináli |
| `KUKUK_URL`, `KUKUK_TOKEN` | – | ak server beží na inom stroji ako Claude Code |
| `KUKUK_MAC_NOTIFY` | `1` | `0` vypne systémové notifikácie na Macu |
| `KUKUK_CONTACT` | URL repozitára | kontakt pre push služby (VAPID `sub`) |
| `KUKUK_DIR` | `~/.kukuk` | kde sú kľúče a spárované zariadenia |

## Bezpečnosť

- Server počúva len na `127.0.0.1`. Von ho pustí až Tailscale/tunel.
- Hook a lišta sa overujú tajným tokenom agenta (`~/.kukuk/config.json`, práva 600).
- Telefón dostane vlastný token len po zadaní jednorazového kódu. Server si ukladá iba jeho hash. Zariadenie odpojíš v appke cez *Nastavenia → Odpárovať*.
- S nastaveným odtlačkom server overuje podpis passkey (WebAuthn, vrátane príznaku overenia používateľa) pri každom povolení.
- Pravidlá `deny` v Claude Code platia vždy. Kukuk ich neprebije.
