// UI wiring for the NFZ Helper SPA.
//
// All search logic lives in the supporting modules; this file is just DOM
// glue: form events, render functions, geolocation, and the OCR pipeline.

import { PROVINCES, provinceName, searchQueues } from "./nfz.js";
import { rank } from "./geo.js";
import {
  isCode,
  lookup,
  isChildCode,
  options as codeOptions,
  searchKeyword,
  CODES
} from "./codes.js";
import { recognize, parseReferral } from "./ocr.js";

const $ = (id) => document.getElementById(id);

const state = {
  patientCoord: null
};

// ---------- bootstrap ----------

function init() {
  populateProvinces();
  wireBenefitHint();
  wirePatientToggle();
  wireGeolocation();
  wireOcr($("ocr-file"));
  wireOcr($("ocr-camera"));
  $("search-form").addEventListener("submit", onSubmit);
}

function populateProvinces() {
  const sel = $("province");

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "cała Polska";
  all.selected = true;
  sel.appendChild(all);

  for (const [code, name] of Object.entries(PROVINCES)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

function populateBenefitOptions() {
  const childOnly = isChildPatient();
  const list = codeOptions({ childOnly });
  const filtered = childOnly && ageBand() === "infant"
    ? list.filter((o) => isInfantCode(o.code))
    : list;

  const datalist = $("benefit-codes");
  datalist.innerHTML = "";
  for (const { code, name } of filtered) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.label = `${name} (${code})`;
    opt.textContent = name;
    datalist.appendChild(opt);
  }
}

// ---------- patient (adult / child + age band) ----------

function wirePatientToggle() {
  document.querySelectorAll('input[name="patient"]').forEach((r) =>
    r.addEventListener("change", refreshPatientUI)
  );
  document.querySelectorAll('input[name="age"]').forEach((r) =>
    r.addEventListener("change", refreshPatientUI)
  );
  refreshPatientUI();
}

function refreshPatientUI() {
  $("age-band").classList.toggle("hidden", !isChildPatient());
  populateBenefitOptions();
  updateBenefitHint();
}

function isChildPatient() {
  const checked = document.querySelector('input[name="patient"]:checked');
  return checked ? checked.value === "child" : false;
}

function ageBand() {
  const checked = document.querySelector('input[name="age"]:checked');
  return checked ? checked.value : null;
}

// Codes that fit "infant" (under 1 year). Anything else with `child: true`
// covers older children (1–17). Names checked case-insensitively against
// the dictionary.
const INFANT_PATTERN = /(neonatolog|pediatryczn)/i;

function isInfantCode(code) {
  const entry = CODES[code];
  if (!entry) return false;
  return INFANT_PATTERN.test(entry.name);
}

// ---------- benefit hint (live code → name preview) ----------

const HINT_DEFAULT =
  "Wpisz nazwę z wydruku skierowania, kod ICD-10 lub 4-cyfrowy kod resortowy (część VIII).";

function wireBenefitHint() {
  const input = $("benefit");
  input.addEventListener("input", updateBenefitHint);
  updateBenefitHint();
}

function updateBenefitHint() {
  const hint = $("benefit-hint");
  const trimmed = ($("benefit").value || "").trim();

  if (isCode(trimmed)) {
    const name = lookup(trimmed);
    if (name) {
      hint.textContent = `kod ${trimmed} → ${name}`;
      hint.className = "mt-2 text-xs font-medium text-brand-700";
    } else {
      hint.textContent = `Kod ${trimmed} nie jest w słowniku — wyszukiwanie może zwrócić pustą listę.`;
      hint.className = "mt-2 text-xs text-amber-700";
    }
  } else {
    hint.textContent = HINT_DEFAULT;
    hint.className = "mt-2 text-xs text-zinc-500";
  }
}

// ---------- geolocation ----------

function wireGeolocation() {
  $("locate-btn").addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      showError("Przeglądarka nie obsługuje geolokalizacji.");
      return;
    }
    const btn = $("locate-btn");
    btn.disabled = true;
    btn.querySelector("svg")?.classList.add("animate-pulse");
    btn.lastChild.textContent = " Pobieram lokalizację…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.patientCoord = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        btn.classList.add("hidden");
        const status = $("locate-status");
        status.classList.remove("hidden");
        status.classList.add("inline-flex");
        const radius = $("radius-control");
        radius.classList.remove("hidden");
        radius.classList.add("inline-flex");
      },
      (err) => {
        btn.disabled = false;
        btn.querySelector("svg")?.classList.remove("animate-pulse");
        btn.lastChild.textContent = " Udostępnij lokalizację";
        showError(`Lokalizacja niedostępna: ${err.message}`);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// ---------- search ----------

async function onSubmit(e) {
  e.preventDefault();
  hideError();
  hideEmpty();
  hideResults();

  const benefitRaw = $("benefit").value.trim();
  const province = $("province").value || null;
  const caseType = parseInt(
    document.querySelector('input[name="case"]:checked').value,
    10
  );

  if (!benefitRaw) return showError("Podaj nazwę poradni / świadczenia.");

  const { query, code } = resolveBenefit(benefitRaw);

  setLoading(true);
  try {
    const queues = await searchQueues({
      caseType,
      province,
      benefit: query,
      onProgress: ({ fetched, total }) => setLoadingProgress(fetched, total)
    });
    const filtered = filterByCode(queues, code);
    const forChild = isChildPatient();
    const ageFiltered = forChild
      ? filtered.filter((q) => isChildEligible(q, ageBand()))
      : filtered;
    const radius = state.patientCoord ? selectedRadiusKm() : null;
    const { results, droppedUnavailable, droppedRadius } = rank(
      ageFiltered,
      state.patientCoord,
      { limit: 5, maxKm: radius }
    );
    renderResults(results, ageFiltered.length, droppedUnavailable, droppedRadius, radius);
  } catch (err) {
    console.error(err);
    showError(`Błąd komunikacji z API NFZ: ${err.message || err}`);
  } finally {
    setLoading(false);
  }
}

function resolveBenefit(input) {
  if (isCode(input)) {
    const stem = searchKeyword(input);
    return { query: stem || input, code: input };
  }
  return { query: input, code: null };
}

function selectedRadiusKm() {
  const v = $("radius").value;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function filterByCode(queues, code) {
  if (!code) return queues;
  const matched = queues.filter((q) => q.idResortPartViii === code);
  return matched.length > 0 ? matched : queues;
}

// Pediatric eligibility:
//   * `infant` — only neonatology / pediatrics (newborn focus)
//   * `child` / `teen` / null — any unit flagged as serving under-18s, plus
//     queues whose benefit string itself names children explicitly
//     ("DLA DZIECI" / "DLA DZIEWCZĄT").
const CHILD_NAME_PATTERN = /(DLA DZIECI|DLA DZIEWCZ|DZIECIĘ)/;

function isChildEligible(queue, age) {
  const code = queue.idResortPartViii;
  if (age === "infant") return code ? isInfantCode(code) : false;
  if (code && isChildCode(code)) return true;
  return CHILD_NAME_PATTERN.test(queue.benefit || "");
}

function setLoading(on) {
  $("submit-btn").disabled = on;
  $("submit-label").textContent = on ? "Szukam…" : "Znajdź placówki";
  $("submit-spinner").classList.toggle("hidden", !on);
}

function setLoadingProgress(fetched, total) {
  if (!total || total <= 1) return;
  $("submit-label").textContent = `Szukam… (${fetched}/${total})`;
}

// ---------- rendering ----------

function renderResults(results, totalFound, droppedUnavailable, droppedRadius = 0, radiusKm = null) {
  if (results.length === 0) {
    const empty = $("empty");
    if (droppedRadius > 0 && radiusKm) {
      empty.innerHTML = `
        <p class="text-sm">W promieniu <strong>${radiusKm} km</strong> nie ma placówek z wolnym terminem.</p>
        <p class="mt-2 text-xs text-zinc-500">Pominięto ${droppedRadius} ${plural(droppedRadius, "placówkę", "placówki", "placówek")} dalej oraz ${droppedUnavailable} bez wolnych terminów. Zwiększ promień lub wybierz "bez limitu".</p>
      `;
    } else if (droppedUnavailable > 0) {
      empty.innerHTML = `
        <p class="text-sm">Żadna z <strong>${droppedUnavailable}</strong> placówek nie ma obecnie wolnych terminów.</p>
        <p class="mt-2 text-xs text-zinc-500">Spróbuj zmienić tryb (pilny / stabilny) lub poszerzyć obszar.</p>
      `;
    } else {
      empty.innerHTML = `
        <p class="text-sm">Nic nie znaleziono.</p>
        <p class="mt-2 text-xs text-zinc-500">Spróbuj innej nazwy świadczenia.</p>
      `;
    }
    empty.classList.remove("hidden");
    return;
  }

  $("results-heading").textContent = "Najlepiej dopasowane placówki";
  const parts = [`${totalFound} ${plural(totalFound, "placówka", "placówki", "placówek")}`];
  if (radiusKm) parts.push(`w promieniu ${radiusKm} km`);
  if (droppedUnavailable > 0) parts.push(`pominięto ${droppedUnavailable} bez wolnych terminów`);
  if (droppedRadius > 0) parts.push(`${droppedRadius} poza promieniem`);
  const meta = $("results-meta");
  meta.textContent = parts.join(" · ");
  meta.classList.remove("hidden");

  const container = $("results");
  container.innerHTML = "";
  results.forEach((r, i) => container.appendChild(renderCard(r, i + 1)));
  $("results-section").classList.remove("hidden");
}

function renderCard(result, idx) {
  const article = document.createElement("article");
  article.className =
    "group rounded-2xl bg-white p-5 shadow-card ring-1 ring-zinc-900/5 transition hover:shadow-lg hover:ring-zinc-900/10 sm:p-6";

  const head = document.createElement("div");
  head.className = "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6";

  // ---- left: provider block ----
  const left = document.createElement("div");
  left.className = "min-w-0 flex-1";

  const eyebrow = document.createElement("div");
  eyebrow.className = "flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400";
  let eyebrowHTML = `<span class="text-brand-700">#${idx}</span>`;
  if (result.queue.idResortPartViii) {
    eyebrowHTML += `<span class="font-mono normal-case tracking-normal text-zinc-500">kod ${escape(result.queue.idResortPartViii)}</span>`;
  }
  eyebrow.innerHTML = eyebrowHTML;
  left.appendChild(eyebrow);

  const h3 = document.createElement("h3");
  h3.className = "mt-2 text-base font-semibold leading-snug text-zinc-900 break-words";
  h3.textContent = result.queue.provider;
  left.appendChild(h3);

  if (result.queue.place) {
    const place = document.createElement("p");
    place.className = "mt-1 text-sm text-zinc-500";
    place.textContent = result.queue.place;
    left.appendChild(place);
  }

  const addrLine = [result.queue.address, result.queue.locality].filter(Boolean).join(", ");
  if (addrLine) {
    const addr = document.createElement("p");
    addr.className = "mt-3 text-sm text-zinc-600";
    addr.textContent = addrLine;
    left.appendChild(addr);
  }

  // ---- right: date treatment ----
  const right = document.createElement("div");
  right.className = "shrink-0 sm:text-right";

  if (result.queue.firstAvailableDate) {
    const d = result.queue.firstAvailableDate;
    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = polishMonth(d.getUTCMonth());
    const year = d.getUTCFullYear();
    const days = result.daysUntil ?? 0;
    right.innerHTML = `
      <div class="flex items-baseline gap-2 sm:justify-end">
        <span class="text-4xl font-semibold leading-none tracking-tight text-zinc-900 tabular-nums">${day}</span>
        <span class="text-lg font-medium text-zinc-700">${month}</span>
        <span class="text-sm text-zinc-400">${year}</span>
      </div>
      <div class="mt-1.5 text-xs text-zinc-500 sm:text-right">
        ${days === 0 ? "dziś" : `za ${days} ${plural(days, "dzień", "dni", "dni")}`}
      </div>
    `;
  } else {
    right.innerHTML = `<div class="text-sm text-zinc-400">brak wolnych terminów</div>`;
  }

  head.appendChild(left);
  head.appendChild(right);
  article.appendChild(head);

  // ---- footer: tags + phone CTA ----
  const footer = document.createElement("div");
  footer.className = "mt-5 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4";

  if (result.distanceKm != null) {
    footer.appendChild(metaPill(`${result.distanceKm.toFixed(1)} km`, "📍"));
  }
  if (result.queue.averagePeriodDays != null && result.queue.averagePeriodDays > 0) {
    footer.appendChild(metaPill(`śr. ${result.queue.averagePeriodDays} dni oczekiwania`, "⏱"));
  }
  const age = ageRangeFor(result.queue);
  if (age) footer.appendChild(metaPill(age, "👶"));

  if (result.queue.phone) {
    const a = document.createElement("a");
    a.href = `tel:${stripPhone(result.queue.phone)}`;
    a.className =
      "ml-auto inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-sm font-semibold text-brand-700 ring-1 ring-brand-100 transition hover:bg-brand-100";
    a.innerHTML = `
      <svg viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5"><path fill-rule="evenodd" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.4a1 1 0 0 1 .96.71l1 3.2a1 1 0 0 1-.27.99l-1.36 1.34a11 11 0 0 0 4.53 4.53l1.34-1.36a1 1 0 0 1 .99-.27l3.2 1a1 1 0 0 1 .71.96v2.4a1.5 1.5 0 0 1-1.5 1.5C8.51 17 3 11.49 3 4.5A1.5 1.5 0 0 1 2 3.5Z" clip-rule="evenodd"/></svg>
      <span class="break-all">${escape(result.queue.phone)}</span>
    `;
    footer.appendChild(a);
  }

  article.appendChild(footer);
  return article;
}

// Derive the served age range from the resort code (preferred) or fall back
// to a heuristic on the benefit / place strings. Returns null for clinics
// with no pediatric signal — adult-only units don't get an age pill.
function ageRangeFor(queue) {
  const code = queue.idResortPartViii;
  const entry = code ? CODES[code] : null;
  const lowName = entry ? entry.name.toLowerCase() : "";

  if (entry) {
    if (/neonatolog/.test(lowName)) return "noworodki (0–28 dni)";
    if (/pediatryczn/.test(lowName)) return "do 18 r.ż.";
    if (/dziewcz/.test(lowName)) return "dziewczęta do 18 r.ż.";
    if (/preluksacyj/.test(lowName)) return "niemowlęta";
    if (entry.child) return "do 18 r.ż.";
    return null;
  }

  // Unknown code — sniff the queue's benefit/place strings.
  const text = `${queue.benefit || ""} ${queue.place || ""}`.toUpperCase();
  if (/NEONATOL/.test(text)) return "noworodki (0–28 dni)";
  if (/DLA DZIEWCZ/.test(text)) return "dziewczęta do 18 r.ż.";
  if (/DLA DZIECI|DZIECIĘ|PEDIATRYCZN/.test(text)) return "do 18 r.ż.";
  return null;
}

function metaPill(text, icon) {
  const span = document.createElement("span");
  span.className = "inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600";
  span.innerHTML = `<span aria-hidden="true" class="text-[11px]">${icon}</span>${escape(text)}`;
  return span;
}

const POLISH_MONTHS = [
  "sty", "lut", "mar", "kwi", "maj", "cze",
  "lip", "sie", "wrz", "paź", "lis", "gru"
];
function polishMonth(idx) { return POLISH_MONTHS[idx] || ""; }

// Polish plural rules: 1 → singular, 2-4 (excl. 12-14) → fewPlural, rest → manyPlural.
function plural(n, one, few, many) {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (abs === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function escape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripPhone(phone) {
  return phone.split(/[\/,;]/)[0].replace(/\s+/g, "");
}

function showError(msg) {
  const el = $("form-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideError() { $("form-error").classList.add("hidden"); }
function hideEmpty() { $("empty").classList.add("hidden"); }
function hideResults() {
  $("results-section").classList.add("hidden");
  $("results-meta").classList.add("hidden");
}

// ---------- OCR ----------

function wireOcr(input) {
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      hideOcrResult();
      hideOcrError();
      showOcrProgress("Pobieram silnik OCR…", 0);

      const text = await recognize(file, ({ status, stage, progress }) => {
        const label =
          status === "loading_engine"
            ? "Pobieram silnik OCR…"
            : stage === "recognizing text"
              ? "Rozpoznaję tekst…"
              : "Przygotowuję rozpoznawanie…";
        showOcrProgress(label, Math.round(progress * 100));
      });

      const parsed = parseReferral(text);
      hideOcrProgress();
      applyOcr(parsed);
    } catch (err) {
      console.error(err);
      hideOcrProgress();
      showOcrError(err.message || String(err));
    } finally {
      input.value = "";
    }
  });
}

function applyOcr(parsed) {
  if (parsed.benefit) {
    $("benefit").value = parsed.resortCode || parsed.benefit;
    updateBenefitHint();
  }
  if (parsed.case) {
    const radio = document.querySelector(`input[name="case"][value="${parsed.case}"]`);
    if (radio) radio.checked = true;
  }
  if (parsed.province) $("province").value = parsed.province;

  const detectedChild =
    (parsed.resortCode && isChildCode(parsed.resortCode)) ||
    (parsed.benefit && CHILD_NAME_PATTERN.test(parsed.benefit.toUpperCase()));
  if (detectedChild) {
    const childRadio = document.querySelector('input[name="patient"][value="child"]');
    if (childRadio) {
      childRadio.checked = true;
      refreshPatientUI();
    }
  }

  const list = $("ocr-result-list");
  list.innerHTML = "";
  if (parsed.benefit) appendItem(list, "Świadczenie", parsed.benefit);
  if (parsed.case) appendItem(list, "Tryb", parsed.case === "2" ? "pilny (CITO)" : "stabilny");
  if (detectedChild) appendItem(list, "Pacjent", "dziecko");
  if (parsed.province) appendItem(list, "Województwo", provinceName(parsed.province));
  if (parsed.icd10 && parsed.icd10.length) appendItem(list, "ICD-10", parsed.icd10.join(", "));
  $("ocr-result").classList.remove("hidden");
}

function appendItem(ul, label, value) {
  const li = document.createElement("li");
  li.className = "flex items-baseline justify-between gap-3";
  li.innerHTML = `
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">${escape(label)}</span>
    <span class="text-right text-sm font-medium text-zinc-800">${escape(value)}</span>
  `;
  ul.appendChild(li);
}

function showOcrProgress(label, pct) {
  $("ocr-progress").classList.remove("hidden");
  $("ocr-label").textContent = label;
  const clamped = Math.max(0, Math.min(100, pct));
  $("ocr-pct").textContent = `${clamped}%`;
  $("ocr-bar").style.width = `${clamped}%`;
}
function hideOcrProgress() { $("ocr-progress").classList.add("hidden"); }
function showOcrError(msg) {
  const el = $("ocr-error");
  el.textContent = `OCR nie powiódł się: ${msg}`;
  el.classList.remove("hidden");
}
function hideOcrError() { $("ocr-error").classList.add("hidden"); }
function hideOcrResult() { $("ocr-result").classList.add("hidden"); }

init();
