"use strict";

// A review-only state machine. It has no persistence, network or payment integration.
const language =
  new URLSearchParams(location.search).get("lang") === "cs" ? "cs" : "en";
const locale = language === "cs" ? "cs-CZ" : "en-GB";
const copy = {
  en: {
    notice:
      "Approval preview · proposed offer and terms · ordering, payment and cancellation are simulated",
    restart: "Restart demo",
    choose: "Choose",
    details: "Details",
    checkout: "Pay",
    title: "Unlimited membership",
    introduction:
      "30 consecutive days of coworking. Choose a single period or automatic renewal every 30 days.",
    tier: "Your workspace",
    open: "Open Space",
    desk: "Reserved Desk",
    workstation: "Reserved Desk + workstation",
    openDescription: "A place in the open space every day, 00:00–17:00.",
    deskDescription:
      "Your own desk throughout the paid period, around the clock. Coffee included.",
    workstationDescription:
      "Your own desk with two monitors throughout the paid period, around the clock. Coffee included.",
    perPeriod: "/ 30 days",
    duration: "How would you like to pay?",
    once: "One 30-day period",
    onceHint: "Pay once. Access ends after the paid period.",
    auto: "Renew automatically every 30 days",
    autoHint:
      "The same total is charged automatically for each new period until you stop renewal.",
    coffee: "Add coffee",
    coffeePrice: "CZK 690 for each 30-day period",
    start: "Start date",
    continue: "Continue",
    summary: "Your membership",
    chargeNow: "First payment",
    access: "Paid access",
    nextCharge: "Next automatic charge",
    renewalAmount: "Every 30 days",
    frequency: "Automatic renewal",
    on: "On",
    off: "Off",
    summaryHelp:
      "All prices are final. All service dates and charge times use Europe/Prague.",
    prepaid: "Entry packs remain prepaid purchases with a one-time payment.",
    account: "Your account",
    holder: "Membership holder",
    self: "You · synthetic demo account",
    billing: "Billing",
    billingValue: "Personal purchase · synthetic details",
    detailsHelp:
      "This review uses a synthetic signed-in account. The production checkout will verify the buyer and billing details.",
    review: "Review and pay",
    reviewHelp:
      "Check the amount and renewal schedule, then give your choices below.",
    mandateTitle: "Automatic payment authorization — required for renewal",
    mandate: (amount, date) =>
      `I authorize Desktechub s.r.o. to charge ${amount} now and ${amount} automatically every 30 days from ${date} until I stop automatic renewal.`,
    cancelHelp: (date) =>
      `Stop renewal in Account → Memberships before ${date}, 00:00 Prague time. Your existing paid access continues to its stated end.`,
    reminder: (date) =>
      `We will email a reminder on ${date}, seven calendar days before the next charge.`,
    agree:
      "I agree to the membership terms and the general Workspace terms (required).",
    early:
      "I expressly request service to start within the 14-day withdrawal period. If I withdraw, I understand that a lawful proportionate amount for service already supplied may be payable (required for this start date).",
    terms: "Read the draft membership terms",
    generalTerms: "General Workspace terms",
    back: "Back",
    order: (amount) => `Order and pay ${amount}`,
    termsUnderReview:
      "These proposed membership terms await owner and legal approval. This preview creates no contract.",
    secureTitle: "Secure payment with Nexi",
    secureHelp:
      "At launch, Nexi will collect the card details and perform any required authentication. Its approved contract will authorize the stated future renewal charges.",
    secureNotice:
      "Simulation boundary. This preview uses no card, token or payment provider. The button below demonstrates a successful result.",
    simulate: "Simulate successful payment",
    accountTitle: "Account · Memberships",
    simulated: "Simulated membership",
    simulatedOff: "Simulated membership · renewal stopped",
    activeTitle: "Your Unlimited membership",
    membershipHelp: "Manage the next automatic payment here.",
    paid: "Paid period (simulation)",
    stop: "Stop automatic renewal",
    manage: "Open Account · Memberships",
    confirmation: "Proposed confirmation",
    confirmationBody:
      "Your confirmation email will contain the accepted terms, payment authorization, amount, service dates and a direct link to stop renewal.",
    cancellationTitle: "Stop automatic renewal?",
    cancellationIntro: (amount) =>
      `This stops the next automatic charge of ${amount} and all following renewals.`,
    cancellationAccess: (date) =>
      `Your paid access continues through ${date}, 23:59 Prague time.`,
    keep: "Keep automatic renewal",
    confirmStop: "Confirm stop renewal",
    stoppedTitle: "Automatic renewal stopped",
    noNext:
      "No further automatic renewal payments are scheduled in this simulation.",
    cancelledReceipt:
      "The live service will confirm the cancellation by email and keep this status available in your account.",
    withdrawal: "Statutory withdrawal",
    withdrawalHelp:
      "Stopping renewal preserves your existing paid period. Where a statutory right to withdraw applies, use the separate online withdrawal flow or contact workspace@deskohub.cz.",
    footer:
      "Deskohub Workspace · Desktechub s.r.o. · IČO 24531596 · proposal prepared for merchant approval",
    termsBack: "Return to the preview",
    everyAmount: (amount) => `${amount} every 30 days`,
  },
  cs: {
    notice:
      "Náhled ke schválení · navrhovaná nabídka a podmínky · objednávka, platba i zrušení jsou simulované",
    restart: "Restartovat ukázku",
    choose: "Výběr",
    details: "Údaje",
    checkout: "Platba",
    title: "Členství Unlimited",
    introduction:
      "30 po sobě jdoucích dnů coworkingu. Zvol si jedno období, nebo automatické obnovování po 30 dnech.",
    tier: "Tvoje pracovní místo",
    open: "Open Space",
    desk: "Reserved Desk",
    workstation: "Reserved Desk + workstation",
    openDescription: "Místo v open space každý den od 00.00 do 17.00.",
    deskDescription:
      "Vlastní stůl po celé uhrazené období, nonstop. Káva v ceně.",
    workstationDescription:
      "Vlastní stůl se dvěma monitory po celé uhrazené období, nonstop. Káva v ceně.",
    perPeriod: "/ 30 dnů",
    duration: "Jak chceš platit?",
    once: "Jedno 30denní období",
    onceHint: "Zaplatíš jednou. Přístup skončí s uhrazeným obdobím.",
    auto: "Automaticky obnovovat po 30 dnech",
    autoHint:
      "Stejná celková částka se automaticky strhne za každé další období, dokud obnovování nezrušíš.",
    coffee: "Přidat kávu",
    coffeePrice: "690 Kč za každé 30denní období",
    start: "Datum začátku",
    continue: "Pokračovat",
    summary: "Tvoje členství",
    chargeNow: "První platba",
    access: "Uhrazený přístup",
    nextCharge: "Příští automatická platba",
    renewalAmount: "Každých 30 dnů",
    frequency: "Automatické obnovování",
    on: "Zapnuto",
    off: "Vypnuto",
    summaryHelp:
      "Ceny jsou konečné. Všechny dny služby a časy plateb se řídí časovým pásmem Europe/Prague.",
    prepaid: "Balíčky vstupů zůstávají předplacené s jednorázovou platbou.",
    account: "Tvůj účet",
    holder: "Držitel členství",
    self: "Ty · syntetický ukázkový účet",
    billing: "Fakturace",
    billingValue: "Osobní nákup · ukázkové údaje",
    detailsHelp:
      "Náhled používá syntetický přihlášený účet. Skutečná objednávka ověří kupujícího a fakturační údaje.",
    review: "Kontrola a platba",
    reviewHelp:
      "Zkontroluj částku a termíny obnovování. Poté potvrď své volby.",
    mandateTitle: "Souhlas s automatickými platbami — povinný pro obnovování",
    mandate: (amount, date) =>
      `Souhlasím, aby Desktechub s.r.o. strhla ${amount} nyní a dále automaticky ${amount} každých 30 dnů od ${date}, dokud automatické obnovování nezruším.`,
    cancelHelp: (date) =>
      `Obnovování zrušíš v Účet → Členství před ${date} v 00.00 pražského času. Již uhrazený přístup trvá do uvedeného konce.`,
    reminder: (date) =>
      `Dne ${date} ti pošleme e-mailové upozornění, sedm kalendářních dnů před další platbou.`,
    agree:
      "Souhlasím s podmínkami členství a obecnými obchodními podmínkami Workspace (povinné).",
    early:
      "Výslovně žádám o zahájení služby během 14denní lhůty pro odstoupení. Beru na vědomí, že při odstoupení mohu být povinen uhradit zákonnou poměrnou část již poskytnuté služby (povinné pro toto datum začátku).",
    terms: "Přečíst návrh podmínek členství",
    generalTerms: "Obecné obchodní podmínky Workspace",
    back: "Zpět",
    order: (amount) => `Objednat a zaplatit ${amount}`,
    termsUnderReview:
      "Navrhované podmínky čekají na schválení vlastníkem a právníkem. Náhled nevytváří smlouvu.",
    secureTitle: "Bezpečná platba přes Nexi",
    secureHelp:
      "Po spuštění zadáš údaje karty u Nexi a provedeš případné požadované ověření. Schválený platební kontrakt umožní uvedené budoucí platby za obnovení.",
    secureNotice:
      "Simulace. Tento náhled nepoužívá kartu, token ani platební bránu. Tlačítko níže ukáže úspěšný výsledek.",
    simulate: "Simulovat úspěšnou platbu",
    accountTitle: "Účet · Členství",
    simulated: "Simulované členství",
    simulatedOff: "Simulované členství · obnovování zrušeno",
    activeTitle: "Tvoje členství Unlimited",
    membershipHelp: "Tady spravuješ příští automatickou platbu.",
    paid: "Uhrazené období (simulace)",
    stop: "Zrušit automatické obnovování",
    manage: "Otevřít Účet · Členství",
    confirmation: "Navrhované potvrzení",
    confirmationBody:
      "Potvrzovací e-mail bude obsahovat přijaté podmínky, souhlas s platbami, částku, období služby a přímý odkaz na zrušení obnovování.",
    cancellationTitle: "Zrušit automatické obnovování?",
    cancellationIntro: (amount) =>
      `Zrušíš tím příští automatickou platbu ${amount} a všechna další obnovení.`,
    cancellationAccess: (date) =>
      `Uhrazený přístup trvá do ${date} do 23.59 pražského času.`,
    keep: "Ponechat automatické obnovování",
    confirmStop: "Potvrdit zrušení obnovování",
    stoppedTitle: "Automatické obnovování zrušeno",
    noNext:
      "V této simulaci už nejsou naplánované další automatické platby za obnovení.",
    cancelledReceipt:
      "Skutečná služba potvrdí zrušení e-mailem a tento stav dál zobrazí v tvém účtu.",
    withdrawal: "Zákonné odstoupení",
    withdrawalHelp:
      "Zrušením obnovování zachováš již uhrazené období. Pokud se uplatní zákonné právo odstoupit, použij samostatné online odstoupení nebo napiš na workspace@deskohub.cz.",
    footer:
      "Deskohub Workspace · Desktechub s.r.o. · IČO 24531596 · návrh pro schválení obchodníka",
    termsBack: "Zpět do náhledu",
    everyAmount: (amount) => `${amount} každých 30 dnů`,
  },
};
const text = copy[language];
const tiers = [
  {
    id: "open",
    title: text.open,
    description: text.openDescription,
    price: 3490,
  },
  {
    id: "desk",
    title: text.desk,
    description: text.deskDescription,
    price: 5990,
  },
  {
    id: "workstation",
    title: text.workstation,
    description: text.workstationDescription,
    price: 8490,
  },
];
const state = {
  tier: "desk",
  auto: false,
  coffee: false,
  start: "2026-12-01",
  started: false,
  stopped: false,
  accepted: false,
  returnFromTerms: "choose",
};
const app = document.getElementById("app");
const amount = (value) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "CZK",
    maximumFractionDigits: 0,
  }).format(value);
// These values are civil dates, formatted in UTC so the browser's zone cannot shift them.
const date = (value) =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
const addDays = (value, days) => {
  const result = new Date(`${value}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};
const chosen = () => tiers.find((tier) => tier.id === state.tier);
const total = () =>
  chosen().price + (state.tier === "open" && state.coffee ? 690 : 0);
const end = () => addDays(state.start, 29);
const next = () => addDays(state.start, 30);
const reminder = () => addDays(next(), -7);
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const early = () => state.start < addDays(today(), 14);

document.documentElement.lang = language === "cs" ? "cs" : "en";
document.getElementById("review-notice").textContent = text.notice;
document.getElementById("restart").textContent = text.restart;
document.getElementById("footer").textContent = text.footer;
const languageButton = document.getElementById("language");
languageButton.textContent = language === "cs" ? "English" : "Čeština";
languageButton.lang = language === "cs" ? "en" : "cs";
languageButton.addEventListener("click", () => {
  const url = new URL(location.href);
  url.searchParams.set("lang", language === "cs" ? "en" : "cs");
  location.href = url.href;
});
document.getElementById("restart").addEventListener("click", () => {
  location.href = `?lang=${language}#choose`;
  location.reload();
});

function progress(step) {
  return `<nav aria-label="${language === "cs" ? "Průběh objednávky" : "Checkout progress"}">
    <ol class="steps">${["choose", "details", "checkout"].map((key) => `<li ${key === step ? 'aria-current="step"' : ""}>${text[key]}</li>`).join("")}</ol>
    </nav>`;
}

function summary() {
  return `<aside class="summary">
    <h2>${text.summary}</h2>
    <p>${chosen().title}${state.coffee && state.tier === "open" ? ` + ${text.coffee.toLowerCase()}` : ""}</p>
    <dl>
    <div>
    <dt>${text.access}</dt>
    <dd>${date(state.start)}<br>– ${date(end())}</dd>
    </div>
    <div>
    <dt>${text.frequency}</dt>
    <dd>${state.auto && !state.stopped ? text.on : text.off}</dd>
    </div>
    ${
      state.auto && !state.stopped
        ? `<div>
    <dt>${text.nextCharge}</dt>
    <dd>${date(next())}<br>00:00 Europe/Prague</dd>
    </div>
    <div>
    <dt>${text.renewalAmount}</dt>
    <dd>${amount(total())}</dd>
    </div>`
        : ""
    }
    <div>
    <dt>${text.chargeNow}</dt>
    <dd class="total">${amount(total())}</dd>
    </div>
  </dl>
    <p class="fine">${text.summaryHelp}</p>
    </aside>`;
}

function termsLink() {
  return `<div class="term-links">
    <a href="#terms">${text.terms}</a>
    <a href="https://workspace.deskohub.cz/${language === "cs" ? "cs-CZ" : "en-US"}/terms-and-conditions" target="_blank" rel="noopener noreferrer">${text.generalTerms}</a>
    </div>`;
}

function renderChoose() {
  app.innerHTML = `${progress("choose")}<h1 tabindex="-1">${text.title}</h1>
    <p class="intro">${text.introduction}</p>
    <div class="layout">
    <form id="choose-form" action="#details">
    <fieldset>
    <legend>${text.tier}</legend>
    <div class="choices">${tiers
      .map(
        (tier) => `<label class="choice" for="tier-${tier.id}">
    <input type="radio" id="tier-${tier.id}" name="tier" value="${tier.id}" ${state.tier === tier.id ? "checked" : ""}>
    <span class="choice-content">
    <span class="choice-title">
    <strong>${tier.title}</strong>
    <span class="price">${amount(tier.price)} ${text.perPeriod}</span>
    </span>
    <span class="hint">${tier.description}</span>
    </span>
    </label>`
      )
      .join("")}</div>
    </fieldset>
    ${
      state.tier === "open"
        ? `<label class="check" for="coffee">
    <input id="coffee" name="coffee" type="checkbox" ${state.coffee ? "checked" : ""}>
    <span>${text.coffee}<span class="hint">${text.coffeePrice}</span>
    </span>
    </label>`
        : ""
    }
    <div class="field">
    <label for="start">${text.start}</label>
    <input id="start" name="start" type="date" required min="${today()}" value="${state.start}">
    </div>
    <fieldset>
    <legend>${text.duration}</legend>
    <div class="choices">
    <label class="choice" for="once">
    <input id="once" type="radio" name="renewal" value="once" ${!state.auto ? "checked" : ""}>
    <span>
    <strong>${text.once}</strong>
    <span class="hint">${text.onceHint}</span>
    </span>
    </label>
    <label class="choice" for="auto">
    <input id="auto" type="radio" name="renewal" value="auto" ${state.auto ? "checked" : ""}>
    <span>
    <strong>${text.auto}</strong>
    <span class="hint">${text.autoHint}</span>
    </span>
    </label>
    </div>
    </fieldset>
    <button class="button" type="submit">${text.continue}</button>
    <p class="fine divider">${text.prepaid}</p>
    </form>${summary()}</div>`;
  const form = document.getElementById("choose-form");
  form.addEventListener("change", (event) => {
    const input = event.target;
    if (input.name === "tier") {
      state.tier = input.value;
      state.coffee = false;
    }
    if (input.name === "renewal") state.auto = input.value === "auto";
    if (input.name === "coffee") state.coffee = input.checked;
    if (input.name === "start" && input.validity.valid)
      state.start = input.value;
    state.accepted = false;
    const focusId = input.id;
    renderChoose();
    document.getElementById(focusId)?.focus({ preventScroll: true });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate("details");
  });
}

function renderDetails() {
  app.innerHTML = `${progress("details")}<h1 tabindex="-1">${text.account}</h1>
    <div class="layout">
    <section>
    <dl class="facts">
    <div>
    <dt>${text.holder}</dt>
    <dd>${text.self}</dd>
    </div>
    <div>
    <dt>${text.billing}</dt>
    <dd>${text.billingValue}</dd>
    </div>
    </dl>
    <p class="fine">${text.detailsHelp}</p>
    <div class="actions">
    <a class="button secondary" href="#choose">${text.back}</a>
    <a class="button" href="#checkout">${text.continue}</a>
    </div>
    </section>${summary()}</div>`;
}

function renderCheckout() {
  state.accepted = false;
  app.innerHTML = `${progress("checkout")}<h1 tabindex="-1">${text.review}</h1>
    <p class="intro">${text.reviewHelp}</p>
    <div class="layout">
    <form id="checkout-form" action="#payment">
    ${
      state.auto
        ? `<div class="consent">
    <h2>${text.mandateTitle}</h2>
    <label class="check" for="mandate">
    <input id="mandate" type="checkbox" name="mandate" required>
    <span>${text.mandate(amount(total()), date(next()))}</span>
    </label>
    <p class="fine">${text.cancelHelp(date(next()))}</p>
    <p class="fine">${text.reminder(date(reminder()))}</p>
    </div>`
        : ""
    }
    ${termsLink()}<label class="check" for="terms">
    <input type="checkbox" id="terms" name="terms" required>
    <span>${text.agree}</span>
    </label>
    ${
      early()
        ? `<label class="check" for="early">
    <input type="checkbox" id="early" name="early" required>
    <span>${text.early}</span>
    </label>`
        : ""
    }
    <p class="fine">${text.termsUnderReview}</p>
    <div class="actions">
    <a class="button secondary" href="#details">${text.back}</a>
    <button class="button" type="submit">${text.order(amount(total()))}</button>
    </div>
    </form>${summary()}</div>`;
  document
    .getElementById("checkout-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      state.accepted = true;
      navigate("payment");
    });
}

function renderPayment() {
  app.innerHTML = `<h1 tabindex="-1">${text.secureTitle}</h1>
    <div class="layout">
    <section>
    <p>${text.secureHelp}</p>
    <p class="notice">${text.secureNotice}</p>
    <div class="actions">
    <a class="button secondary" href="#checkout">${text.back}</a>
    <button class="button" id="simulate" type="button">${text.simulate}</button>
    </div>
    </section>${summary()}</div>`;
  document.getElementById("simulate").addEventListener("click", () => {
    state.started = true;
    navigate("membership");
  });
}

function renderMembership() {
  app.innerHTML = `<p class="fine">${text.accountTitle}</p>
    <span class="status ${state.stopped ? "stopped" : ""}">${state.stopped ? text.simulatedOff : text.simulated}</span>
    <h1 tabindex="-1">${text.activeTitle}</h1>
    <div class="layout">
    <section>
    <h2>${chosen().title}</h2>
    <p>${text.cancellationAccess(date(end()))}</p>${
      state.auto && !state.stopped
        ? `<p>${text.everyAmount(amount(total()))}</p>
    <p>${text.reminder(date(reminder()))}</p>
    <div class="actions">
    <a class="button secondary" href="#cancel">${text.stop}</a>
    </div>`
        : `<p>${text.noNext}</p>`
    }<section class="divider">
    <h2>${text.confirmation}</h2>
    <p class="fine">${text.confirmationBody}</p>${termsLink()}</section>
    <section class="divider">
    <h2>${text.withdrawal}</h2>
    <p class="fine">${text.withdrawalHelp}</p>
    </section>
    </section>${summary()}</div>`;
}

function renderCancel() {
  app.innerHTML = `<div class="narrow">
    <p class="fine">${text.accountTitle}</p>
    <h1 tabindex="-1">${text.cancellationTitle}</h1>
    <p>${chosen().title}</p>
    <p>${text.cancellationIntro(amount(total()))}</p>
    <p class="notice">${text.cancellationAccess(date(end()))}</p>
    <p>${text.cancelHelp(date(next()))}</p>
    <div class="actions">
    <a class="button secondary" href="#membership">${text.keep}</a>
    <button id="stop" class="button danger" type="button">${text.confirmStop}</button>
    </div>
    <section class="divider">
    <h2>${text.withdrawal}</h2>
    <p class="fine">${text.withdrawalHelp}</p>
    </section>
    </div>`;
  document.getElementById("stop").addEventListener("click", () => {
    state.stopped = true;
    navigate("cancelled");
  });
}

function renderCancelled() {
  app.innerHTML = `<div class="narrow confirmation">
    <span class="status stopped">${text.simulatedOff}</span>
    <h1 tabindex="-1">${text.stoppedTitle}</h1>
    <p>${chosen().title}</p>
    <p>${text.noNext}</p>
    <p class="notice">${text.cancellationAccess(date(end()))}</p>
    <p class="fine">${text.cancelledReceipt}</p>
    <div class="actions">
    <a class="button secondary" href="#membership">${text.manage}</a>
    </div>
    </div>`;
}

function renderTerms() {
  const terms = window.membershipTerms[language];
  app.innerHTML = `<article class="terms">
    <h1 tabindex="-1">${terms.title}</h1>
    <p class="intro">${terms.subtitle}</p>
    <p class="notice">${terms.notice}</p>${terms.sections
      .map(
        ([heading, body]) => `<section>
    <h2>${heading}</h2>
    <p>${body}</p>
    </section>`
      )
      .join("")}<div class="actions">
    <a class="button secondary" href="#${state.returnFromTerms}">${text.termsBack}</a>
    <button id="print" class="button secondary" type="button">${language === "cs" ? "Vytisknout návrh" : "Print draft"}</button>
    </div>
    </article>`;
  document
    .getElementById("print")
    .addEventListener("click", () => window.print());
}

let previousStep = "choose";
function render() {
  let step = location.hash.slice(1) || "choose";
  const screens = {
    choose: renderChoose,
    details: renderDetails,
    checkout: renderCheckout,
    payment: renderPayment,
    membership: renderMembership,
    cancel: renderCancel,
    cancelled: renderCancelled,
    terms: renderTerms,
  };
  if (!Object.hasOwn(screens, step)) step = "choose";
  if (step === "payment" && !state.accepted) step = "checkout";
  if (["membership", "cancel", "cancelled"].includes(step) && !state.started)
    step = "choose";
  if (step === "cancel" && (!state.auto || state.stopped)) step = "membership";
  if (step === "cancelled" && !state.stopped) step = "membership";
  if (
    state.started &&
    ["choose", "details", "checkout", "payment"].includes(step)
  )
    step = "membership";
  if (step === "terms" && previousStep !== "terms")
    state.returnFromTerms = previousStep;
  if (location.hash !== `#${step}`) history.replaceState(null, "", `#${step}`);
  screens[step]();
  previousStep = step;
  document.title = `Deskohub · ${app.querySelector("h1").textContent} · ${language === "cs" ? "Návrh" : "Proposal"}`;
  app.querySelector("h1").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function navigate(step) {
  location.hash = step;
}
window.addEventListener("hashchange", render);
render();
