/** ABC ("All but coupon clipping"): the recurring credits on cards Minty knows. Facts compiled
 * from Frequent Miler, cross-checked with Doctor of Credit, The Points Guy, Upgraded Points and
 * the issuers' pages, on CHECKED. Benefits change a few times a year: re-check and update here
 * (every fork gets the update with "Sync fork"). Never fetched at runtime.
 *
 * Matching (src/benefits/engine.ts) uses SQL LIKE patterns, case-insensitive:
 *  - `credit`: the statement credit's description. Every pattern names the credit itself (it
 *    contains "Credit" or a label only credits carry), so a positive row that matches is a
 *    reversal of that credit, never a purchase. Never match on a bare merchant word: a resort in
 *    Wisconsin DELLS is not Dell.
 *  - `charge`: the qualifying purchase (name or Plaid's merchant_name). Used to count a credit
 *    in the period of its purchase (the April credit that posts on May 2), to show "charged,
 *    credit pending", and for spend thresholds.
 *  - `labelSeen`: the credit pattern is confirmed from real statements. Otherwise it's a best
 *    guess, and the page says so. */

export const CHECKED = "2026-10-12";

export type Period = "monthly" | "quarterly" | "semiannual" | "annual" | "every_4_years";

export interface Benefit {
  id: string;
  name: string;
  amountCents: number;               // per period
  period: Period;
  /** calendar = Jan–Dec periods; card_year = periods start in the card's anniversary month. */
  basis: "calendar" | "card_year";
  /** on_card: a charge on the card, then a statement credit. outside: e.g. Uber Cash in the app;
   * listed, with a tick box. */
  how: "on_card" | "outside";
  enroll: boolean;
  credit?: string[];
  charge?: string[];
  labelSeen?: boolean;
  /** Only available after this much spend at `charge` merchants in the period. */
  unlockSpendCents?: number;
  /** The credit posts under the merchant's own name (Hilton: "Hilton" -$50), so money back at
   * `charge` merchants counts as the credit, unless it equals an earlier purchase (a refund). */
  merchantCredit?: boolean;
  /** The credit posts as a refund of the purchase itself, under the merchant's bare name
   * (Walmart+: the membership charge, then "Walmart" for the same amount). Exact names, no %;
   * only money back up to maxCents (the credit plus tax) counts. */
  creditAsRefund?: { names: string[]; maxCents: number };
  /** Shares `credit` with another benefit and gets what's left once that one is full. */
  after?: string;
  decemberExtraCents?: number;       // Uber Cash: $20 more in December
  note: string;
  source: string;
}

export interface Product {
  id: string;
  name: string;
  issuer: string;
  feeCents: number;
  /** How a linked card is recognised: its bank (LIKE on institution_name) and either its Plaid
   * account name, or a credit on it that only this product gets. */
  institution: string;
  accountNames: string[];
  creditEvidence?: string[];
  benefits: Benefit[];
}

const FM = "https://frequentmiler.com";
const SRC = {
  platinum: `${FM}/895-platinum-card/`,
  saksEnded: `${FM}/amex-removes-saks-benefit-for-new-platinum-cardholders-cardholders-prior-to-3-26-unaffected/`,
  bizPlatinum: "https://upgradedpoints.com/credit-cards/reviews/amex-business-platinum/benefits/",
  chatgpt: `${FM}/american-express-adds-300-in-chatgpt-credits-on-business-platinum-and-business-gold-cards/`,
  bizGold: "https://upgradedpoints.com/credit-cards/reviews/american-express-business-gold-card/benefits-history/",
  ups: `${FM}/fedex-being-removed-from-flexible-business-credit-on-american-express-business-gold-card-from-10-1-26/`,
  squarespace: `${FM}/american-express-business-gold-adds-150-squarespace-credit/`,
  strata: "https://www.citi.com/credit-cards/credit-card-rewards/citi-strata-premier-benefits",
  altitude: `${FM}/u-s-bank-altitude-reserve-major-changes-expected-in-december-is-it-the-end/`,
};

const $ = (dollars: number) => Math.round(dollars * 100);

// Shared by the Platinum cards.
const hotel = (source: string): Benefit => ({
  id: "hotel", name: "Hotel credit (Fine Hotels + Resorts / The Hotel Collection)", amountCents: $(300), period: "semiannual",
  basis: "calendar", how: "on_card", enroll: false, labelSeen: true,
  credit: ["%Platinum Hotel Credit%", "%Fine Hotels%Credit%", "%Hotel Collection%Credit%"],
  note: "Prepaid FHR or Hotel Collection booking through Amex Travel (Hotel Collection: 2+ nights). Jan–Jun and Jul–Dec.",
  source,
});
const airline = (source: string): Benefit => ({
  id: "airline", name: "Airline fee credit", amountCents: $(200), period: "annual", basis: "calendar", how: "on_card", enroll: true,
  credit: ["%Airline Fee%Credit%", "%Airline Incidental%Credit%", "%Airline Credit%"],
  note: "Incidental fees (bags, seats, lounge passes) on the one airline you select with Amex; not airfare.",
  source,
});
const clear = (source: string): Benefit => ({
  id: "clear", name: "CLEAR+ credit", amountCents: $(219), period: "annual", basis: "calendar", how: "on_card", enroll: false,
  credit: ["%CLEAR Plus%Credit%", "%CLEAR+%Credit%", "%CLEAR Credit%", "%CLEAR Membership%Credit%"],
  charge: ["CLEAR%", "%CLEARME%"],
  note: "An auto-renewing CLEAR+ membership charged to the card.",
  source,
});
const globalEntry = (amount: number, source: string, issuer = "Amex"): Benefit => ({
  id: "global_entry", name: "Global Entry / TSA PreCheck credit", amountCents: $(amount), period: "every_4_years", basis: "calendar",
  how: "on_card", enroll: false,
  credit: ["%Global Entry%Credit%", "%TSA Pre%Credit%", "%Precheck%Credit%", "%Global Entry%Fee%Credit%"],
  charge: ["%GLOBAL ENTRY%", "%TSA PRE%", "%TSA PRECHECK%", "%U.S. CUSTOMS%", "%IDEMIA%", "%TELOS ID%"],
  note: `Once every 4 years (${issuer} counts from the last reimbursement).`,
  source,
});
const walmartPlus = (source: string): Benefit => ({
  id: "walmart_plus", name: "Walmart+ credit", amountCents: $(12.95), period: "monthly", basis: "calendar", how: "on_card", enroll: false,
  credit: ["%Walmart+%Credit%", "%Walmart Plus%Credit%", "%Walmart%Membership%Credit%"],
  creditAsRefund: { names: ["Walmart"], maxCents: $(12.95 * 1.15) },
  charge: ["%Walmart+%", "%WMT PLUS%", "%Walmart Plus%", "%WALMART.COM MEMBERSHIP%"],
  note: "A monthly (not annual) Walmart+ membership: $12.95 plus tax each month. The credit shows as \"Walmart\" money back for the membership charge.",
  source,
});
const chatgpt: Benefit = {
  id: "chatgpt", name: "ChatGPT Business credit", amountCents: $(300), period: "annual", basis: "calendar", how: "on_card", enroll: true,
  labelSeen: true, credit: ["%ChatGPT Business Credit%", "%ChatGPT%Credit%"], charge: ["OPENAI%", "%CHATGPT%"],
  note: "ChatGPT Business bought directly from OpenAI (U.S.). Up to $300 a year in any amounts; credits can take up to 8 weeks.",
  source: SRC.chatgpt,
};

// Additional products checked against issuer pages on 2026-10-23. Unconfirmed statement
// descriptions keep labelSeen false, so the existing UI labels matching as provisional.
const GOLD_SOURCE='https://www.americanexpress.com/en-us/account/get-started/gold/explore-benefits';
const ASPIRE_SOURCE='https://global.americanexpress.com/card-benefits/view-all/hilton-aspire';
const SURPASS_SOURCE='https://global.americanexpress.com/card-benefits/detail/hilton-credit/hilton-surpass';
const VENTURE_SOURCE='https://www.capitalone.com/credit-cards/venture-x/';
const DELTA_SOURCE='https://www.americanexpress.com/en-us/business/credit-cards/delta-skymiles-gold/';
const SUMMIT_SOURCE='https://www.bankofamerica.com/credit-cards/products/alaska-airlines-infinite-credit-card/';
const extraCredit=(id:string,name:string,amount:number,period:Period,source:string,credit:string[],note:string,charge:string[]=[],enroll=false):Benefit=>
 ({id,name,amountCents:$(amount),period,basis:'calendar',how:'on_card',enroll,credit,charge,note,source});
export const PRODUCTS: Product[] = [
  {
    id: "amex_business_platinum", name: "American Express Business Platinum", issuer: "American Express", feeCents: $(895),
    institution: "American Express%", accountNames: ["Business Platinum%", "%Business Platinum Card%"],
    benefits: [
      hotel(SRC.bizPlatinum),
      { id: "hilton", name: "Hilton credit", amountCents: $(50), period: "quarterly", basis: "calendar", how: "on_card", enroll: true,
        credit: ["%Hilton%Credit%"], merchantCredit: true, labelSeen: true,
        charge: ["HILTON%", "%HAMPTON INN%", "%DOUBLETREE%", "%EMBASSY SUITES%", "%CONRAD%", "%WALDORF%", "%CURIO%", "%HOMEWOOD%"],
        note: "Hilton stays charged directly by the hotel. Needs a (free) Hilton for Business membership and enrollment.", source: SRC.bizPlatinum },
      { id: "indeed", name: "Indeed credit", amountCents: $(90), period: "quarterly", basis: "calendar", how: "on_card", enroll: true,
        credit: ["%Indeed%Credit%"], charge: ["INDEED%"], note: "Indeed hiring and recruiting products.", source: SRC.bizPlatinum },
      { id: "wireless", name: "Wireless phone credit", amountCents: $(10), period: "monthly", basis: "calendar", how: "on_card", enroll: true,
        labelSeen: true, credit: ["%Wireless Credit%"],
        charge: ["T-MOBILE%", "TMOBILE%", "VERIZON%", "VZWRLSS%", "AT&T%", "ATT*%", "%MINT MOBILE%", "VISIBLE%", "GOOGLE *FI%", "CRICKET%", "US MOBILE%"],
        note: "Phone service bought directly from a U.S. wireless carrier.", source: SRC.bizPlatinum },
      { id: "dell", name: "Dell credit", amountCents: $(150), period: "annual", basis: "calendar", how: "on_card", enroll: true,
        labelSeen: true, credit: ["Dell Credit%", "%Dell Statement Credit%", "%Dell Technologies%Credit%"],
        charge: ["DELL INC%", "Dell Inc%", "DELL.COM%", "DELL MARKETING%", "DELL TECHNOLOGIES%"],
        note: "U.S. purchases directly with Dell. Once a year (no longer split Jan–Jun / Jul–Dec).", source: SRC.bizPlatinum },
      { id: "dell_plus", name: "Dell credit, after $5,000 at Dell", amountCents: $(1000), period: "annual", basis: "calendar", how: "on_card",
        enroll: true, after: "dell", unlockSpendCents: $(5000),
        credit: ["Dell Credit%", "%Dell Statement Credit%", "%Dell Technologies%Credit%"],
        charge: ["DELL INC%", "Dell Inc%", "DELL.COM%", "DELL MARKETING%", "DELL TECHNOLOGIES%"],
        note: "Up to $1,000 more once Dell purchases on the card reach $5,000 in the year.", source: SRC.bizPlatinum },
      { id: "adobe", name: "Adobe credit, after $600 at Adobe", amountCents: $(250), period: "annual", basis: "calendar", how: "on_card",
        enroll: true, unlockSpendCents: $(600), credit: ["%Adobe%Credit%"], charge: ["ADOBE%"],
        note: "One $250 credit once Adobe purchases on the card reach $600 in the year.", source: SRC.bizPlatinum },
      { ...chatgpt },
      airline(SRC.bizPlatinum),
      clear(SRC.bizPlatinum),
      globalEntry(120, SRC.bizPlatinum),
    ],
  },
  {
    // After Business Platinum, so "Business Platinum Card®" never lands here.
    id: "amex_platinum", name: "American Express Platinum", issuer: "American Express", feeCents: $(895),
    institution: "American Express%",
    accountNames: ["Platinum Card%", "The Platinum Card%", "Charles Schwab Platinum%", "Morgan Stanley Platinum%", "%Platinum Card® from American Express%"],
    benefits: [
      hotel(SRC.platinum),
      { id: "resy", name: "Resy credit", amountCents: $(100), period: "quarterly", basis: "calendar", how: "on_card", enroll: true,
        labelSeen: true, credit: ["%Resy Credit%"], charge: ["RESY*%", "RESY %", "%RESY.COM%"],
        note: "U.S. restaurants on Resy, and Resy purchases.", source: SRC.platinum },
      { id: "lululemon", name: "lululemon credit", amountCents: $(75), period: "quarterly", basis: "calendar", how: "on_card", enroll: true,
        labelSeen: true, credit: ["%Lululemon Credit%"], charge: ["LULULEMON%", "%LULULEMON.COM%"],
        note: "U.S. lululemon stores (not outlets) and lululemon.com.", source: SRC.platinum },
      { id: "entertainment", name: "Digital entertainment credit", amountCents: $(25), period: "monthly", basis: "calendar", how: "on_card",
        enroll: true, credit: ["%Digital Entertainment%Credit%", "%Entertainment Credit%"],
        charge: ["DISNEY%", "%DISNEYPLUS%", "HULU%", "ESPN%", "PARAMOUNT%", "%PEACOCK%", "%NYTIMES%", "%NEW YORK TIMES%", "WSJ%", "%WALL STREET JOURNAL%", "%YOUTUBE%"],
        note: "Disney+, Hulu, ESPN, Paramount+, Peacock (direct only, from Aug 2026), NYTimes, WSJ, YouTube Premium / TV.", source: SRC.platinum },
      { id: "uber_cash", name: "Uber Cash", amountCents: $(15), decemberExtraCents: $(20), period: "monthly", basis: "calendar", how: "outside",
        enroll: false, note: "Loaded into your Uber account each month ($35 in December): check the Uber app, then tick it here.", source: SRC.platinum },
      { id: "uber_one", name: "Uber One credit", amountCents: $(120), period: "annual", basis: "calendar", how: "on_card", enroll: false,
        credit: ["%Uber One%Credit%"], charge: ["%UBER ONE%"], note: "An auto-renewing Uber One membership charged to the card.", source: SRC.platinum },
      walmartPlus(SRC.platinum),
      { id: "oura", name: "Oura credit", amountCents: $(200), period: "annual", basis: "calendar", how: "on_card", enroll: true,
        credit: ["%Oura%Credit%"], charge: ["OURA%", "%OURARING%"], note: "Oura Ring purchases at ouraring.com.", source: SRC.platinum },
      { id: "equinox", name: "Equinox credit", amountCents: $(300), period: "annual", basis: "calendar", how: "on_card", enroll: true,
        credit: ["%Equinox%Credit%"], charge: ["EQUINOX%"], note: "Equinox club or Equinox+ membership.", source: SRC.platinum },
      airline(SRC.platinum),
      clear(SRC.platinum),
      globalEntry(120, SRC.platinum),
    ],
  },
  {
    id: "amex_business_gold", name: "American Express Business Gold", issuer: "American Express", feeCents: $(375),
    institution: "American Express%", accountNames: ["Business Gold%", "%Business Gold Card%"],
    benefits: [
      { id: "flexible", name: "Flexible business credit", amountCents: $(20), period: "monthly", basis: "calendar", how: "on_card", enroll: true,
        labelSeen: true, credit: ["%Flexible Business Credit%"],
        charge: ["%GRUBHUB%", "%STAPLES%", "%OFFICE DEPOT%", "%OFFICEMAX%", "%FEDEX%", "UPS*%", "UPS %", "%UPS.COM%"],
        note: "Grubhub, U.S. office supply stores and UPS.com shipments, combined (FedEx until Sep 30, 2026).", source: SRC.ups },
      walmartPlus(SRC.bizGold),
      { ...chatgpt },
      { id: "squarespace", name: "Squarespace credit", amountCents: $(150), period: "annual", basis: "calendar", how: "on_card", enroll: true,
        credit: ["%Squarespace%Credit%"], charge: ["SQUARESPACE%", "SQSP%", "%ACUITY%"],
        note: "U.S. purchases directly with Squarespace (or Acuity Scheduling).", source: SRC.squarespace },
    ],
  },
  {
    id: "citi_strata_premier", name: "Citi Strata Premier", issuer: "Citi", feeCents: $(95),
    institution: "Citi%", accountNames: ["Citi Strata Premier%"],
    benefits: [
      { id: "hotel_100", name: "$100 off a $500+ hotel stay", amountCents: $(100), period: "annual", basis: "calendar", how: "outside", enroll: false,
        note: "Taken off the price of one hotel stay of $500+ booked through Citi Travel, so no credit shows: tick it here.", source: SRC.strata },
    ],
  },
  {
    id: "usbank_altitude_reserve", name: "U.S. Bank Altitude Reserve", issuer: "U.S. Bank", feeCents: $(400),
    institution: "U.S. Bank%", accountNames: ["%Altitude Reserve%"], creditEvidence: ["Annual Travel/dining Credit%"],
    benefits: [
      { id: "travel", name: "Annual travel credit", amountCents: $(325), period: "annual", basis: "card_year", how: "on_card", enroll: false,
        labelSeen: true, credit: ["Annual Travel/dining Credit%", "%Travel/dining Credit%", "%Annual Travel Credit%"],
        note: "Per card year. Since Dec 15, 2025 only U.S. Bank Travel Center bookings count (dining no longer does), although statements still say \"Travel/dining\".",
        source: SRC.altitude },
      globalEntry(100, SRC.altitude, "U.S. Bank"),
    ],
  },
  {
    id:'amex_gold',name:'American Express Gold',issuer:'American Express',feeCents:$(325),
    institution:'American Express%',accountNames:['Gold Card%','% Gold Card%','American Express Gold%'],
    benefits:[
      extraCredit('dining','Dining credit',10,'monthly',GOLD_SOURCE,['%DINING%CREDIT%'],'Enrollment required. Only the current participating U.S. dining partners qualify.',[],true),
      extraCredit('resy','Resy credit',50,'semiannual',GOLD_SOURCE,['%RESY%CREDIT%'],'Enrollment required; eligible U.S. Resy purchases, January-June and July-December.',[],true),
      extraCredit('dunkin','Dunkin credit',7,'monthly',GOLD_SOURCE,['%DUNKIN%CREDIT%'],'Enrollment required; eligible U.S. Dunkin purchases.',['%DUNKIN%'],true),
      {id:'uber_cash',name:'Uber Cash',amountCents:$(10),period:'monthly',basis:'calendar',how:'outside',enroll:false,note:'Add the Gold card to Uber. U.S. Uber Cash expires monthly; tick after using it.',source:GOLD_SOURCE}
    ]
  },
  {
    id:'hilton_aspire',name:'Hilton Honors Aspire',issuer:'American Express',feeCents:$(550),
    institution:'American Express%',accountNames:['%Hilton%Aspire%'],
    benefits:[
      extraCredit('flight','Flight credit',50,'quarterly',ASPIRE_SOURCE,['%FLIGHT%CREDIT%','%AIRLINE%CREDIT%'],'Eligible airfare purchased directly with airlines or through Amex Travel; up to $50 per calendar quarter.'),
      extraCredit('resort','Hilton resort credit',200,'semiannual',ASPIRE_SOURCE,['%HILTON%RESORT%CREDIT%','%RESORT%CREDIT%'],'Eligible charges at participating Hilton resorts; January-June and July-December.'),
      {...clear(ASPIRE_SOURCE),amountCents:$(209)}
    ]
  },
  {
    id:'hilton_surpass',name:'Hilton Honors Surpass',issuer:'American Express',feeCents:$(150),
    institution:'American Express%',accountNames:['%Hilton%Surpass%'],
    benefits:[extraCredit('hilton','Hilton credit',50,'quarterly',SURPASS_SOURCE,['%HILTON%CREDIT%'],'Eligible purchases charged directly by a Hilton portfolio property; up to $50 each calendar quarter.')]
  },
  {
    id:'venture_x',name:'Capital One Venture X',issuer:'Capital One',feeCents:$(395),
    institution:'Capital One%',accountNames:['Venture X','Venture X %','% - Venture X'],
    benefits:[{id:'travel',name:'Capital One Travel credit',amountCents:$(300),period:'annual',basis:'card_year',how:'outside',enroll:false,note:'Use through Capital One Travel before your account anniversary. Set the card-year month; tick after using the portal credit.',source:VENTURE_SOURCE},globalEntry(120,VENTURE_SOURCE,'Capital One')]
  },
  {
    id:'delta_gold_business',name:'Delta SkyMiles Gold Business',issuer:'American Express',feeCents:$(150),
    institution:'American Express%',accountNames:['Delta Gold Business%','%Delta%Gold%Business%'],
    benefits:[extraCredit('delta_stays','Delta Stays credit',150,'annual',DELTA_SOURCE,['%DELTA%STAYS%CREDIT%'],'Eligible prepaid hotels and vacation rentals booked through Delta Stays. Check issuer terms for bookings and refunds.')]
  },
  {
    id:'atmos_summit',name:'Atmos Rewards Summit',issuer:'Bank of America',feeCents:$(395),
    institution:'Bank of America%',accountNames:['%Atmos%Summit%'],
    benefits:[globalEntry(120,SUMMIT_SOURCE,'Bank of America')]
  },

  {
    id:'bilt_palladium',name:'Bilt Palladium',issuer:'Bilt',feeCents:$(495),
    institution:'%',accountNames:['%Bilt%Palladium%'],
    benefits:[
      {id:'hotel',name:'Bilt Travel hotel credit',amountCents:$(200),period:'semiannual',basis:'calendar',how:'outside',enroll:false,note:'Opt in during a qualifying Bilt Travel booking of at least two nights. January-June and July-December; often deducted at checkout. Tick when used.',source:'https://www.biltrewards.com/terms/bilt-card-offer-terms'},
      {id:'bilt_cash',name:'Annual Bilt Cash',amountCents:$(200),period:'annual',basis:'calendar',how:'outside',enroll:false,note:'Annual Bilt Cash allocation, separate from the welcome bonus. Tick after redeeming it; unused balances follow Bilt Cash rollover and expiration rules.',source:'https://www.biltrewards.com/terms/bilt-card-offer-terms'}
    ]
  },
  {
    id:'chase_sapphire_preferred',name:'Chase Sapphire Preferred',issuer:'Chase',feeCents:$(95),
    institution:'Chase%',accountNames:['%Sapphire Preferred%'],
    benefits:[{...extraCredit('hotel','Chase Travel hotel credit',100,'annual','https://media.chase.com/news/Meet-the-New-Chase-Sapphire-Preferred',['%HOTEL%CREDIT%'],'Current terms announced June 15, 2026: up to $100 each account anniversary. Earlier periods had a $50 limit; historical totals use the current catalog. Confirm your anniversary month.'),basis:'card_year'},globalEntry(120,'https://media.chase.com/news/Meet-the-New-Chase-Sapphire-Preferred','Chase')]
  },

];

export const productById = new Map(PRODUCTS.map((p) => [p.id, p]));

/** Shown on the page: what ABC leaves out, so nobody wonders. */
export const NOT_TRACKED = [
  "Delta renewal-dependent rideshare benefits, conditional travel-delay reimbursements and stay-specific property credits.",
  "Perks that aren't dollar credits (lounges, status, free-night or anniversary points).",
  "Business Platinum credits that unlock only after $250,000 of spend in a year.",
  "The Schwab Platinum's Appreciation Bonus (it depends on Schwab holdings).",
  "The Platinum Saks credit, which ended on June 30, 2026.",
];
