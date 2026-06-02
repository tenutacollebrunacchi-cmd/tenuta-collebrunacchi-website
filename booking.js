// booking.js — Tenuta Collebrunacchi Booking Widget
// Vanilla JS. Requires: @supabase/supabase-js (CDN) + window.BOOKING_CONFIG

(function () {
  'use strict'

  // ── Config ──────────────────────────────────────────────────
  const C = window.BOOKING_CONFIG || {}
  const SUPABASE_URL      = C.supabaseUrl      || ''
  const SUPABASE_ANON_KEY = C.supabaseAnonKey  || ''
  const EDGE_URL          = C.edgeFunctionsUrl || ''
  const WA_URL            = 'https://wa.me/393311682664'
  const FORMSPREE_URL     = 'https://formspree.io/f/mojbrpbv'
  let PRICES              = {
    shared:  { online: 159, arrival: 169 },
    private: { online: 259, arrival: 269 },
  }
  const MAX_GUESTS  = 10
  const TIME_SLOTS  = ['10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00']
  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December']
  const DAY_NAMES   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

  // ── State ───────────────────────────────────────────────────
  let S = {
    step:          'calendar', // calendar | loading_slots | slots | form | submitting | redirecting | arrival_sent
    year:          new Date().getFullYear(),
    month:         new Date().getMonth(),
    monthSlots:    [],
    dateSlots:     [],
    selectedDate:  null,
    selectedSlot:  null,
    bookingType:   'shared',
    paymentMethod: 'online',  // 'online' | 'arrival'
    persons:       2,
    error:         null,
    groupFilter:   1,
    slotMinimums:  {},        // { 'HH:MM' → min_persons } for the selected date
  }

  let db = null
  let _submitLock = false
  let CANCEL_HOURS = 48

  // ── Boot ────────────────────────────────────────────────────
  async function init () {
    if (!document.getElementById('bw-root')) return
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      document.getElementById('bw-root').innerHTML =
        '<p style="color:#C0392B;padding:20px">Booking widget: missing BOOKING_CONFIG.</p>'
      return
    }
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    injectCSS()
    await Promise.all([loadPrices(), loadCancellationPolicy()])
    render()
    fetchMonthSlots()

    // Restore fresh data if browser resurrects this page from bfcache (e.g. back from Stripe)
    window.addEventListener('pageshow', e => {
      if (!e.persisted) return
      S.step = 'calendar'; S.monthSlots = []; S.selectedDate = null; S.selectedSlot = null
      S.error = null; _submitLock = false
      render()
      fetchMonthSlots()
    })
  }

  // ── Data ────────────────────────────────────────────────────
  async function fetchMonthSlots () {
    const first = isoDate(S.year, S.month, 1)
    const last  = isoDate(S.year, S.month, daysInMonth(S.year, S.month))
    const { data, error } = await db
      .from('slots')
      .select('id,date,time,capacity_left,is_private_blocked')
      .gte('date', first).lte('date', last)
      .order('date').order('time')
    console.log('slots response:', data, error)
    if (!error && data) { S.monthSlots = data; render() }
  }

  async function fetchDateSlots (date) {
    const [slotsRes, minimumsRes] = await Promise.all([
      db.from('slots')
        .select('id,date,time,capacity_left,is_private_blocked')
        .eq('date', date).order('time'),
      db.from('slot_minimums')
        .select('time,min_persons')
        .eq('date', date)
    ])
    if (!slotsRes.error && slotsRes.data) S.dateSlots = slotsRes.data
    S.slotMinimums = {}
    ;(minimumsRes.data || []).forEach(m => {
      S.slotMinimums[m.time.slice(0,5)] = m.min_persons
    })
  }

  async function loadCancellationPolicy () {
    const { data, error } = await db
      .from('cancellation_policies')
      .select('free_cancellation_hours')
      .eq('is_active', true)
      .limit(1)
      .single()
    if (!error && data?.free_cancellation_hours != null) {
      CANCEL_HOURS = data.free_cancellation_hours
    }
  }

  async function loadPrices () {
    const { data, error } = await db
      .from('price_settings')
      .select('shared_online_price,shared_arrival_price,private_online_price,private_arrival_price')
      .limit(1)
      .single()
    if (!error && data) {
      PRICES = {
        shared:  { online: data.shared_online_price,  arrival: data.shared_arrival_price  },
        private: { online: data.private_online_price, arrival: data.private_arrival_price },
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────
  function render () {
    const root = document.getElementById('bw-root')
    if (!root) return
    const html = {
      calendar:      renderCalendar,
      loading_slots: renderLoadingSlots,
      slots:         renderSlots,
      form:          renderForm,
      submitting:    S.paymentMethod === 'arrival'
                       ? renderBusy('Sending your request…')
                       : renderBusy('Creating your booking…'),
      redirecting:   renderBusy('Redirecting to secure payment…'),
      arrival_sent:  renderArrivalSent,
    }[S.step]
    root.innerHTML = `<div class="bw">${html()}</div>`
    bind()
  }

  function renderCalendar () {
    const isTruffleSeason = (S.month === 9 || S.month === 10 || S.month === 11)
    const today    = todayStr()
    const firstDow = dayOfWeekMon(new Date(S.year, S.month, 1))
    const days     = daysInMonth(S.year, S.month)
    const prevOk   = !(S.year === new Date().getFullYear() && S.month === new Date().getMonth())

    let grid = DAY_NAMES.map(d => `<div class="bw-dh">${d}</div>`).join('')
    for (let i = 0; i < firstDow; i++) grid += `<div class="bw-dc bw-dc--empty"></div>`

    for (let d = 1; d <= days; d++) {
      const ds    = isoDate(S.year, S.month, d)
      const past  = ds < today
      const avail = dayAvail(ds)

      let cls = 'bw-dc'
      let dot = ''
      if (past)                      cls += ' bw-dc--past'
      else if (avail === 'available') { cls += ' bw-dc--avail'; dot = '<span class="bw-dot-avail"></span>' }
      else if (avail === 'full')      { cls += ' bw-dc--full';  dot = '<span class="bw-dot-full"></span>'  }
      else                             cls += ' bw-dc--none'
      if (ds === today)               cls += ' bw-dc--today'
      if (ds === S.selectedDate)      cls += ' bw-dc--sel'

      if (isTruffleSeason && avail === 'available') cls += ' bw-dc--demand'
      const clickable = !past && avail === 'available'
      grid += `<button class="${cls}" ${clickable ? `data-date="${ds}"` : 'disabled'} type="button">
        <span>${d}</span>${dot}
      </button>`
    }

    const groupOpts = [1,2,3,4,5,6,7,8,9].map(n =>
      `<button class="bw-gopt${S.groupFilter===n?' bw-gopt--on':''}" data-group="${n}" type="button">${n}</button>`
    ).join('') +
    `<button class="bw-gopt${S.groupFilter===10?' bw-gopt--on':''}" data-group="10" type="button">10+</button>`

    const groupNote = S.groupFilter === 10
      ? `<a href="${WA_URL}" class="bw-group-wa" target="_blank" rel="noopener noreferrer">Groups of 10+? Contact us on WhatsApp →</a>`
      : ''

    return `
      <div class="bw-group-filter">
        <span class="bw-group-lbl">How many people?</span>
        <div class="bw-group-opts">${groupOpts}</div>
        ${groupNote}
      </div>
      <div class="bw-cal-nav">
        <button class="bw-nav" id="bwPrev" type="button" ${!prevOk ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span class="bw-month-lbl">${MONTH_NAMES[S.month]} ${S.year}</span>
        <button class="bw-nav" id="bwNext" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
      <div class="bw-cal-grid">${grid}</div>
      <div class="bw-legend">
        <span><span class="bw-dot-avail"></span> Available</span>
        <span><span class="bw-dot-full"></span> Fully booked</span>
        ${isTruffleSeason ? '<span><span class="bw-legend-demand"></span> High demand</span>' : ''}
      </div>`
  }

  function renderLoadingSlots () {
    return `<div class="bw-busy"><div class="bw-spin"></div><p>Loading times…</p></div>`
  }

  function renderSlots () {
    const d    = S.selectedDate
    const dObj = new Date(d + 'T12:00:00')
    const fmt  = dObj.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})

    const btns = TIME_SLOTS.map(t => {
      const sl = S.dateSlots.find(s => s.time.slice(0,5) === t)
      if (!sl)                            return slotBtn(t,'Unavailable','bw-sl--none',  true)
      if (sl.is_private_blocked)          return slotBtn(t,'Private',   'bw-sl--priv',  true)
      if (Number(sl.capacity_left) === 0) return slotBtn(t,'Full',      'bw-sl--full',  true)
      const isSlotEmpty = Number(sl.capacity_left) === MAX_GUESTS
      const slMin = isSlotEmpty ? (S.slotMinimums[t] || 1) : 1
      const lbl = slMin > 1
        ? `Min. ${slMin} guests`
        : (Number(sl.capacity_left) <= 3 ? 'Last spots' : 'Available')
      return slotBtn(t, lbl, 'bw-sl--avail', false, sl.id)
    }).join('')

    return `
      <button class="bw-back" id="bwBackCal" type="button">← Back to calendar</button>
      <h3 class="bw-date-hd">${fmt}</h3>
      <p class="bw-sub">Select a start time:</p>
      <div class="bw-sl-grid">${btns}</div>`
  }

  function slotBtn (time, label, cls, disabled, slotId) {
    return `<button class="bw-sl ${cls}" type="button"
      ${slotId ? `data-slot="${slotId}"` : ''} ${disabled ? 'disabled' : ''}>
      <span class="bw-sl-time">${time}</span>
      <span class="bw-sl-lbl">${label}</span>
    </button>`
  }

  function renderForm () {
    const sl      = S.selectedSlot
    const dObj    = new Date(sl.date + 'T12:00:00')
    const fmtDate = dObj.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})
    const fmtTime = sl.time.slice(0,5)
    const price   = PRICES[S.bookingType][S.paymentMethod]
    const total   = price * S.persons
    const cap     = Number(sl.capacity_left)

    const sharedLow  = S.bookingType === 'shared' && S.persons > cap
    const privLocked = cap < 10
    const overMax    = S.persons > MAX_GUESTS
    const soldOut    = S.bookingType === 'shared' && cap === 0
    const isSlotEmpty  = cap === MAX_GUESTS
    const slMin        = isSlotEmpty ? (S.slotMinimums[sl.time.slice(0,5)] || 1) : 1
    const minimumBlocked = isSlotEmpty && slMin > 1 && S.persons < slMin
    const showWa     = !minimumBlocked && (soldOut || overMax)

    const privTip = privLocked
      ? `<small>Not available — ${10 - cap} spot${10 - cap !== 1 ? 's' : ''} already taken</small>`
      : `<small>Exclusive for your group</small>`

    const typeToggle = `
      <div class="bw-type-row">
        <button class="bw-type ${S.bookingType==='shared'  ? 'bw-type--on' : ''}"
                data-bwtype="shared" type="button">
          <strong>Shared group</strong><span>€${PRICES.shared[S.paymentMethod]}/person</span>
          <small>${cap > 0 ? `${cap} spot${cap!==1?'s':''} left` : 'Full'}</small>
        </button>
        <button class="bw-type ${S.bookingType==='private' ? 'bw-type--on' : ''} ${privLocked ? 'bw-type--off' : ''}"
                data-bwtype="private" type="button" ${privLocked ? 'disabled' : ''}>
          <strong>Private</strong><span>€${PRICES.private[S.paymentMethod]}/person</span>
          ${privTip}
        </button>
      </div>`

    const counter = `
      <div class="bw-guests">
        <span class="bw-guests-lbl">Guests</span>
        <div class="bw-counter">
          <button class="bw-cnt" id="bwMinus" type="button">−</button>
          <span class="bw-cnt-val">${S.persons}</span>
          <button class="bw-cnt" id="bwPlus" type="button">+</button>
        </div>
        ${sharedLow && !overMax ? `
          <div class="bw-wa-insufficient">
            <p>Not enough spots for your group — only ${cap} spot${cap!==1?'s':''} available in this slot.</p>
            <a href="${WA_URL}" target="_blank" rel="noopener noreferrer" class="bw-wa-link" style="font-size:12px;padding:9px 18px;display:inline-flex;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              Contact us on WhatsApp
            </a>
          </div>
        ` : ''}
        ${overMax ? `<p class="bw-warn">Maximum ${MAX_GUESTS} guests per booking.</p>` : ''}
      </div>`

    const priceSummary = `
      <div class="bw-price">
        <span>${S.persons} × €${price}</span>
        <strong>Total: €${total.toLocaleString()}</strong>
        <span style="font-size:12px;color:var(--warm-gray);">VAT included / IVA inclusa</span>
      </div>`

    const paySelector = `
      <div class="bw-pay-row">
        <button class="bw-pay-opt ${S.paymentMethod==='online' ? 'bw-pay-opt--on' : ''}"
                data-bwpay="online" type="button">
          <div class="bw-pay-header">
            <strong>Pay online now</strong>
            <span class="bw-pay-badge">Best price</span>
          </div>
          <span class="bw-pay-price">€${PRICES[S.bookingType].online}/person</span>
          <small>Secure payment via Stripe</small>
        </button>
        <button class="bw-pay-opt ${S.paymentMethod==='arrival' ? 'bw-pay-opt--on' : ''}"
                data-bwpay="arrival" type="button">
          <strong>Pay on arrival</strong>
          <span class="bw-pay-price">€${PRICES[S.bookingType].arrival}/person</span>
          <small>We confirm within 24 hours</small>
        </button>
      </div>`

    const waFallback = `
      <div class="bw-wa-box">
        <p>For groups over ${MAX_GUESTS} or custom arrangements:</p>
        <a href="${WA_URL}" target="_blank" rel="noopener noreferrer" class="bw-wa-link">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          Message Eleonora on WhatsApp
        </a>
      </div>`

    const submitLabel = S.paymentMethod === 'arrival'
      ? `Reserve my spot · €${total.toLocaleString()} →`
      : `Proceed to Payment · €${total.toLocaleString()} →`

    const submitNote = S.paymentMethod === 'arrival'
      ? `We'll confirm your booking by email within 24 hours. Free cancellation up to ${CANCEL_HOURS}h before.`
      : `Secure payment via Stripe. Free cancellation up to ${CANCEL_HOURS} hours before.`

    const bookingForm = `
      <form id="bwForm" novalidate>
        <div class="bw-honey" aria-hidden="true">
          <label for="bw-website">Website</label>
          <input type="text" id="bw-website" name="website" autocomplete="off" tabindex="-1">
        </div>
        <div class="bw-form-row">
          <div class="bw-fg">
            <label class="bw-lbl" for="bwName">Full name *</label>
            <input class="bw-inp" id="bwName" name="name" type="text"
                   placeholder="Your name" required autocomplete="name">
          </div>
          <div class="bw-fg">
            <label class="bw-lbl" for="bwEmail">Email *</label>
            <input class="bw-inp" id="bwEmail" name="email" type="email"
                   placeholder="your@email.com" required autocomplete="email">
          </div>
        </div>
        <div class="bw-fg">
          <label class="bw-lbl" for="bwPhone">Phone / WhatsApp</label>
          <input class="bw-inp" id="bwPhone" name="phone" type="tel"
                 placeholder="+1 234 567 890" autocomplete="tel">
        </div>
        <div class="bw-fg">
          <label class="bw-lbl" for="bwNotes">Special requests <em>(optional)</em></label>
          <textarea class="bw-inp bw-ta" id="bwNotes" name="notes"
            placeholder="Dietary requirements, accessibility, special occasions…"></textarea>
        </div>
        ${S.error ? `<p class="bw-err">${sanitize(S.error)}</p>` : ''}
        <button type="submit" class="bw-submit">${submitLabel}</button>
        <p class="bw-fnote">${submitNote}</p>
      </form>`

    return `
      <button class="bw-back" id="bwBackSlots" type="button">← Back to times</button>
      <div class="bw-booking-hd">
        <span class="bw-bdate">${fmtDate}</span>
        <span class="bw-btime">Starting at ${fmtTime}</span>
      </div>
      ${typeToggle}
      ${counter}
      ${priceSummary}
      ${paySelector}
      ${minimumBlocked ? `
        <div class="bw-wa-box">
          <p>Minimum <strong>${slMin} guests</strong> required for the first booking on this slot — contact us for smaller groups.</p>
          <a href="${WA_URL}" target="_blank" rel="noopener noreferrer" class="bw-wa-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            Message Eleonora on WhatsApp
          </a>
        </div>` : (showWa ? waFallback : bookingForm)}`
  }

  function renderArrivalSent () {
    const sl        = S.selectedSlot
    const dObj      = new Date(sl.date + 'T12:00:00')
    const fmtDate   = dObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    const fmtTime   = sl.time.slice(0, 5)
    const typeLabel = S.bookingType === 'private' ? 'Private Experience' : 'Small Group'
    return `
      <div class="bw-arrival-ok">
        <div class="bw-arrival-icon">✓</div>
        <h3>Request received.</h3>
        <p>We'll confirm your booking within 24 hours.</p>
        <p style="margin-top:12px;font-size:13px;color:var(--charcoal,#1C1C1A);font-weight:600;">
          ${fmtDate} · ${fmtTime}<br>
          <span style="font-weight:400;color:var(--warm-gray,#6B6B64);">${S.persons} ${S.persons === 1 ? 'person' : 'people'} · ${typeLabel}</span>
        </p>
        <p style="margin-top:16px;font-size:12px;">
          Check your inbox for a copy of your request.
          Questions? <a href="${WA_URL}" style="color:var(--terra,#8B5E3C);">Message us on WhatsApp</a>.
        </p>
        <button id="bwBookAgain" type="button" style="margin-top:24px;background:none;border:1.5px solid var(--border,#E0D8CC);border-radius:4px;padding:10px 20px;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--warm-gray,#6B6B64);cursor:pointer;">
          ← Book another experience
        </button>
      </div>`
  }

  function renderBusy (msg) {
    return () => `
      <div class="bw-busy">
        <div class="bw-spin"></div>
        <p>${msg}</p>
      </div>`
  }

  // ── Event binding ─────────────────────────────────────────────
  function bind () {
    on('bwPrev',      'click', prevMonth)
    on('bwNext',      'click', nextMonth)
    on('bwBackCal',   'click', () => { S.step = 'calendar'; S.monthSlots = []; render(); fetchMonthSlots() })
    on('bwBackSlots', 'click', () => { S.step = 'slots'; S.error = null; render() })
    on('bwBookAgain', 'click', () => {
      S.step = 'calendar'; S.selectedDate = null; S.selectedSlot = null
      S.error = null; S.monthSlots = []; render(); fetchMonthSlots()
    })
    on('bwMinus',     'click', () => { if (S.persons > 1)          { S.persons--; render() } })
    on('bwPlus',      'click', () => { if (S.persons < MAX_GUESTS) { S.persons++; render() } })

    // Day click (calendar)
    qsa('[data-date]', el => el.addEventListener('click', async e => {
      const date = e.currentTarget.dataset.date
      S.selectedDate = date
      S.step = 'loading_slots'
      render()
      await fetchDateSlots(date)
      S.step = 'slots'
      render()
    }))

    // Slot click
    qsa('[data-slot]', el => el.addEventListener('click', e => {
      const id = e.currentTarget.dataset.slot
      const sl = S.dateSlots.find(s => s.id === id)
      if (sl) {
        S.selectedSlot = sl; S.step = 'form'; S.error = null
        if (S.groupFilter >= 1 && S.groupFilter < 10) S.persons = S.groupFilter
        render()
      }
    }))

    // Group size filter
    qsa('[data-group]', el => el.addEventListener('click', e => {
      S.groupFilter = Number(e.currentTarget.dataset.group)
      render()
    }))

    // Type toggle
    qsa('[data-bwtype]', el => el.addEventListener('click', e => {
      if (e.currentTarget.disabled) return
      S.bookingType = e.currentTarget.dataset.bwtype
      render()
    }))

    // Payment method toggle
    qsa('[data-bwpay]', el => el.addEventListener('click', e => {
      S.paymentMethod = e.currentTarget.dataset.bwpay
      render()
    }))

    // Form submit
    const form = document.getElementById('bwForm')
    if (form) {
      form.addEventListener('submit', handleSubmit)
      qsa('.bw-inp', el => el.addEventListener('input', () => { el.style.borderColor = '' }))
    }
  }

  // ── Form submit ───────────────────────────────────────────────
  async function handleSubmit (e) {
    e.preventDefault()
    if (_submitLock) return
    const honeypot = document.getElementById('bw-website')
    if (honeypot && honeypot.value) return // bot detected — silently ignore
    const name  = val('bwName')
    const email = val('bwEmail')
    const phone = val('bwPhone')
    const notes = val('bwNotes')

    let ok = true
    ;['bwName','bwEmail'].forEach(id => {
      const el = document.getElementById(id)
      if (el && !el.value.trim()) { el.style.borderColor = '#C0392B'; ok = false }
    })
    if (!ok) return

    _submitLock = true
    S.step = 'submitting'; S.error = null; render()

    // ── Pay on arrival → Edge Function (reserves slot in DB) ─
    if (S.paymentMethod === 'arrival') {
      try {
        const res = await fetch(`${EDGE_URL}/create-arrival-booking`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            slot_id: S.selectedSlot.id,
            name,
            email,
            phone:   phone || null,
            persons: S.persons,
            type:    S.bookingType,
            notes:   notes || null,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          if (data.sold_out) {
            await fetchDateSlots(S.selectedDate)
            _submitLock = false
            S.step  = 'form'
            S.error = 'Sorry — this slot just sold out. Please choose a different time.'
            render(); return
          }
          throw new Error(data.error || `Server error ${res.status}`)
        }

        _submitLock = false
        S.step = 'arrival_sent'
        render()
      } catch (err) {
        console.error('Arrival booking error:', err)
        _submitLock = false
        S.step  = 'form'
        S.error = err.message || 'Something went wrong. Please try again or message us on WhatsApp.'
        render()
      }
      return
    }

    // ── Pay online → Stripe ──────────────────────────────────
    try {
      const res = await fetch(`${EDGE_URL}/create-checkout`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          slot_id: S.selectedSlot.id,
          name,
          email,
          phone:   phone || null,
          persons: S.persons,
          type:    S.bookingType,
          notes:   notes || null,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data.sold_out) {
          await fetchDateSlots(S.selectedDate)
          _submitLock = false
          S.step  = 'form'
          S.error = 'Sorry — this slot just sold out. Please choose a different time.'
          render(); return
        }
        throw new Error(data.error || `Server error ${res.status}`)
      }

      if (data.url) {
        S.step = 'redirecting'; render()
        window.location.href = data.url
      } else {
        throw new Error('No checkout URL in response')
      }

    } catch (err) {
      console.error('Booking error:', err)
      _submitLock = false
      S.step  = 'form'
      S.error = err.message || 'Something went wrong. Please try again or message us on WhatsApp.'
      render()
    }
  }

  // ── Calendar helpers ──────────────────────────────────────────
  function prevMonth () {
    if (S.month === 0) { S.month = 11; S.year-- } else S.month--
    S.monthSlots = []; render(); fetchMonthSlots()
  }

  function nextMonth () {
    if (S.month === 11) { S.month = 0; S.year++ } else S.month++
    S.monthSlots = []; render(); fetchMonthSlots()
  }

  function dayAvail (dateStr) {
    const slots = S.monthSlots.filter(s => (s.date ?? '').slice(0, 10) === dateStr)
    if (!slots.length) return 'none'
    const needed = S.groupFilter < 10 ? S.groupFilter : 1
    if (slots.some(s => !s.is_private_blocked && Number(s.capacity_left) >= needed)) return 'available'
    if (slots.some(s => !s.is_private_blocked && Number(s.capacity_left) > 0)) return 'full'
    return 'full'
  }

  function daysInMonth (y, m) { return new Date(y, m + 1, 0).getDate() }
  function dayOfWeekMon (d) { const dow = d.getDay(); return dow === 0 ? 6 : dow - 1 }
  function isoDate (y, m, d) {
    return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
  }
  function todayStr () { return new Date().toISOString().slice(0, 10) }

  // ── DOM helpers ───────────────────────────────────────────────
  function sanitize (s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
  }
  function on (id, evt, fn) { document.getElementById(id)?.addEventListener(evt, fn) }
  function qsa (sel, fn) { document.querySelectorAll(sel).forEach(fn) }
  function val (id) { return (document.getElementById(id)?.value || '').trim() }

  // ── Styles ────────────────────────────────────────────────────
  function injectCSS () {
    if (document.getElementById('bw-styles')) return
    const s = document.createElement('style')
    s.id = 'bw-styles'
    s.textContent = `
/* ── Booking Widget ──────────────────────────────────────────── */
.bw { font-family: var(--font-sans,'Inter',sans-serif); max-width:660px; margin:0 auto; }

/* Calendar nav */
.bw-cal-nav {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:20px;
}
.bw-month-lbl {
  font-family:var(--font-serif,'Playfair Display',serif);
  font-size:20px; font-weight:500; color:var(--charcoal,#1C1C1A);
}
.bw-nav {
  width:36px; height:36px; border-radius:50%; border:1.5px solid var(--border,#E0D8CC);
  background:transparent; display:flex; align-items:center; justify-content:center;
  cursor:pointer; color:var(--warm-gray,#6B6B64);
  transition:border-color .2s,color .2s;
}
.bw-nav:hover:not([disabled]) { border-color:var(--terra,#8B5E3C); color:var(--terra,#8B5E3C); }
.bw-nav[disabled] { opacity:.3; cursor:default; }

/* Calendar grid */
.bw-cal-grid {
  display:grid; grid-template-columns:repeat(7,1fr); gap:4px;
  margin-bottom:16px;
}
.bw-dh {
  text-align:center; font-size:10px; font-weight:600; letter-spacing:1px;
  text-transform:uppercase; color:var(--warm-gray,#6B6B64); padding:6px 0;
}
.bw-dc {
  position:relative; aspect-ratio:1; border-radius:6px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  font-size:14px; border:none; background:transparent;
  transition:background .15s,color .15s;
}
.bw-dc span { pointer-events:none; }
.bw-dc--empty { }
.bw-dc--past  { color:#C8C2BA; cursor:default; }
.bw-dc--none  { color:#C8C2BA; cursor:default; }
.bw-dc--full  { color:var(--warm-gray,#6B6B64); cursor:default; }
.bw-dc--avail {
  background:var(--cream,#F2EDE3); color:var(--charcoal,#1C1C1A);
  cursor:pointer;
}
.bw-dc--avail:hover { background:var(--terra,#8B5E3C); color:#fff; }
.bw-dc--avail:hover .bw-dot-avail { background:#fff; }
.bw-dc--today { font-weight:700; }
.bw-dc--sel   { background:var(--terra,#8B5E3C) !important; color:#fff !important; }
.bw-dc--sel .bw-dot-avail { background:#fff !important; }

/* Availability dots */
.bw-dot-avail, .bw-dot-full {
  width:5px; height:5px; border-radius:50%;
  display:block; margin-top:3px;
}
.bw-dot-avail { background:var(--verde-light,#4A7040); }
.bw-dot-full  { background:#C8C2BA; }

/* Legend */
.bw-legend {
  display:flex; gap:20px; font-size:12px; color:var(--warm-gray,#6B6B64);
}
.bw-legend span { display:flex; align-items:center; gap:6px; }

/* Back button */
.bw-back {
  display:inline-flex; align-items:center; gap:6px;
  font-size:12px; font-weight:600; letter-spacing:.5px; text-transform:uppercase;
  color:var(--warm-gray,#6B6B64); background:none; border:none; cursor:pointer;
  margin-bottom:20px; padding:0; transition:color .2s;
}
.bw-back:hover { color:var(--terra,#8B5E3C); }

/* Date header on slots/form */
.bw-date-hd {
  font-family:var(--font-serif,'Playfair Display',serif);
  font-size:22px; font-weight:500; color:var(--charcoal,#1C1C1A); margin-bottom:6px;
}
.bw-sub { font-size:14px; color:var(--warm-gray,#6B6B64); margin-bottom:20px; }

/* Slot buttons */
.bw-sl-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.bw-sl {
  border-radius:6px; border:1.5px solid var(--border,#E0D8CC);
  padding:14px 8px; display:flex; flex-direction:column; align-items:center;
  gap:4px; cursor:pointer; background:var(--ivory,#FAFAF5);
  transition:border-color .2s,background .2s;
}
.bw-sl:disabled { opacity:.45; cursor:default; }
.bw-sl-time { font-size:15px; font-weight:600; color:var(--charcoal,#1C1C1A); }
.bw-sl-lbl  { font-size:11px; color:var(--warm-gray,#6B6B64); }
.bw-sl--avail:not([disabled]):hover { border-color:var(--terra,#8B5E3C); background:var(--cream,#F2EDE3); }
.bw-sl--avail:not([disabled]):hover .bw-sl-time { color:var(--terra,#8B5E3C); }

/* Booking summary header */
.bw-booking-hd {
  display:flex; flex-direction:column; gap:3px; margin-bottom:24px;
  padding-bottom:20px; border-bottom:1px solid var(--border,#E0D8CC);
}
.bw-bdate {
  font-family:var(--font-serif,'Playfair Display',serif);
  font-size:22px; font-weight:500; color:var(--charcoal,#1C1C1A);
}
.bw-btime { font-size:14px; color:var(--warm-gray,#6B6B64); }

/* Type toggle */
.bw-type-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:20px; }
.bw-type {
  border:1.5px solid var(--border,#E0D8CC); border-radius:8px;
  padding:16px; background:var(--ivory,#FAFAF5); cursor:pointer; text-align:left;
  display:flex; flex-direction:column; gap:3px;
  transition:border-color .2s,background .2s;
}
.bw-type strong { font-size:14px; font-weight:600; color:var(--charcoal,#1C1C1A); }
.bw-type span   { font-size:13px; color:var(--terra,#8B5E3C); font-weight:600; }
.bw-type small  { font-size:11px; color:var(--warm-gray,#6B6B64); }
.bw-type--on  { border-color:var(--terra,#8B5E3C); background:var(--cream,#F2EDE3); }
.bw-type--off { opacity:.45; cursor:default; }
.bw-type:not(.bw-type--off):not([disabled]):hover { border-color:var(--terra,#8B5E3C); }

/* Guest counter */
.bw-guests { display:flex; align-items:center; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
.bw-guests-lbl { font-size:13px; font-weight:600; color:var(--charcoal,#1C1C1A); }
.bw-counter { display:flex; align-items:center; gap:0; border:1.5px solid var(--border,#E0D8CC); border-radius:6px; overflow:hidden; }
.bw-cnt {
  width:38px; height:38px; background:none; border:none; cursor:pointer;
  font-size:18px; color:var(--charcoal,#1C1C1A);
  transition:background .15s;
}
.bw-cnt:hover { background:var(--cream,#F2EDE3); }
.bw-cnt-val { width:40px; text-align:center; font-size:16px; font-weight:600; border-left:1px solid var(--border,#E0D8CC); border-right:1px solid var(--border,#E0D8CC); line-height:38px; }
.bw-warn { font-size:12px; color:#C0392B; }

/* Price summary */
.bw-price {
  display:flex; justify-content:space-between; align-items:center;
  background:var(--cream,#F2EDE3); border-radius:6px; padding:14px 18px;
  margin-bottom:16px;
}
.bw-price span  { font-size:14px; color:var(--warm-gray,#6B6B64); }
.bw-price strong { font-family:var(--font-serif,'Playfair Display',serif); font-size:20px; color:var(--charcoal,#1C1C1A); }

/* Payment method selector */
.bw-pay-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px; }
.bw-pay-opt {
  border:1.5px solid var(--border,#E0D8CC); border-radius:8px;
  padding:16px; background:var(--ivory,#FAFAF5); cursor:pointer; text-align:left;
  display:flex; flex-direction:column; gap:4px;
  transition:border-color .2s,background .2s;
}
.bw-pay-header { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.bw-pay-opt strong { font-size:14px; font-weight:600; color:var(--charcoal,#1C1C1A); }
.bw-pay-opt small  { font-size:11px; color:var(--warm-gray,#6B6B64); }
.bw-pay-price { font-size:15px; font-weight:700; color:var(--terra,#8B5E3C); margin-top:2px; }
.bw-pay-badge {
  display:inline-block; background:var(--verde-light,#4A7040); color:#fff;
  font-size:9px; font-weight:700; letter-spacing:.5px; text-transform:uppercase;
  padding:2px 7px; border-radius:40px; flex-shrink:0;
}
.bw-pay-opt--on {
  border-color:var(--terra,#8B5E3C); border-width:2px;
  background:var(--cream,#F2EDE3);
}
.bw-pay-opt:not(.bw-pay-opt--on):hover { border-color:var(--terra,#8B5E3C); }

/* WhatsApp fallback */
.bw-wa-box {
  background:var(--cream,#F2EDE3); border-radius:8px; padding:24px;
  text-align:center; margin-top:8px;
}
.bw-wa-box p { font-size:14px; color:var(--warm-gray,#6B6B64); margin-bottom:16px; }
.bw-wa-link {
  display:inline-flex; align-items:center; gap:10px;
  background:#25D366; color:#fff; font-size:13px; font-weight:600;
  letter-spacing:.5px; text-transform:uppercase; text-decoration:none;
  padding:12px 24px; border-radius:40px;
  transition:background .2s;
}
.bw-wa-link:hover { background:#1DA855; }

/* Booking form */
.bw-form-row { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.bw-fg { margin-bottom:16px; }
.bw-lbl {
  display:block; font-size:11px; font-weight:600; letter-spacing:2px;
  text-transform:uppercase; color:var(--warm-gray,#6B6B64); margin-bottom:7px;
}
.bw-lbl em { font-style:normal; font-weight:400; letter-spacing:0; text-transform:none; font-size:11px; }
.bw-inp {
  width:100%; padding:12px 14px; font-family:inherit; font-size:14px;
  color:var(--charcoal,#1C1C1A); background:#fff;
  border:1.5px solid var(--border,#E0D8CC); border-radius:4px;
  outline:none; transition:border-color .2s; -webkit-appearance:none;
}
.bw-inp:focus { border-color:var(--terra,#8B5E3C); }
.bw-inp::placeholder { color:#B8B0A4; }
.bw-ta { resize:vertical; min-height:90px; }
.bw-err { color:#C0392B; font-size:13px; margin:12px 0; }
.bw-submit {
  width:100%; padding:15px; margin-top:8px;
  background:var(--terra,#8B5E3C); color:#fff;
  font-family:inherit; font-size:13px; font-weight:600;
  letter-spacing:1.5px; text-transform:uppercase;
  border:none; border-radius:4px; cursor:pointer;
  transition:background .2s;
}
.bw-submit:hover { background:var(--terra-dark,#6B4528); }
.bw-fnote { font-size:12px; color:var(--warm-gray,#6B6B64); margin-top:12px; text-align:center; line-height:1.6; }

/* Arrival booking confirmed */
.bw-arrival-ok { text-align:center; padding:40px 24px; }
.bw-arrival-icon {
  width:56px; height:56px; border-radius:50%;
  background:var(--verde-light,#4A7040); color:#fff;
  font-size:24px; display:flex; align-items:center; justify-content:center;
  margin:0 auto 20px;
}
.bw-arrival-ok h3 {
  font-family:var(--font-serif,'Playfair Display',serif);
  font-size:22px; font-weight:500; color:var(--charcoal,#1C1C1A); margin-bottom:10px;
}
.bw-arrival-ok p { font-size:14px; color:var(--warm-gray,#6B6B64); line-height:1.7; }

/* Group size filter */
.bw-group-filter {
  display:flex; align-items:center; gap:14px; margin-bottom:28px;
  flex-wrap:wrap; padding-bottom:20px; border-bottom:1px solid var(--border,#E0D8CC);
}
.bw-group-lbl {
  font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase;
  color:var(--warm-gray,#6B6B64); flex-shrink:0;
}
.bw-group-opts { display:flex; flex-wrap:wrap; gap:5px; }
.bw-gopt {
  min-width:34px; height:34px; padding:0 9px;
  border-radius:4px; border:1.5px solid var(--border,#E0D8CC);
  background:var(--ivory,#FAFAF5); font-size:13px; font-weight:500;
  color:var(--charcoal,#1C1C1A); cursor:pointer;
  transition:border-color .15s,background .15s,color .15s;
}
.bw-gopt:hover { border-color:var(--terra,#8B5E3C); }
.bw-gopt--on { background:var(--terra,#8B5E3C); border-color:var(--terra,#8B5E3C); color:#fff; }
.bw-group-wa {
  font-size:12px; color:var(--terra,#8B5E3C); text-decoration:underline;
  text-underline-offset:2px; width:100%; margin-top:4px;
}

/* High demand badge — truffle season (Oct–Dec) */
.bw-dc--demand::before {
  content:''; position:absolute; top:4px; right:4px;
  width:5px; height:5px; border-radius:50%;
  background:var(--gold,#C4A456);
}
.bw-legend-demand {
  display:inline-block; width:5px; height:5px; border-radius:50%;
  background:var(--gold,#C4A456); margin-right:4px; vertical-align:middle;
}

/* Insufficient spots WhatsApp CTA */
.bw-wa-insufficient {
  background:var(--cream,#F2EDE3); border-radius:6px;
  padding:14px 16px; margin-top:4px;
}
.bw-wa-insufficient p {
  font-size:13px; color:var(--charcoal,#1C1C1A); margin-bottom:10px; line-height:1.5;
}

/* Honeypot — visible to bots, hidden from humans */
.bw-honey { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; opacity:0; pointer-events:none; }

/* Busy / loading */
.bw-busy {
  display:flex; flex-direction:column; align-items:center;
  padding:60px 20px; gap:18px; color:var(--warm-gray,#6B6B64);
}
.bw-spin {
  width:32px; height:32px; border:3px solid var(--border,#E0D8CC);
  border-top-color:var(--terra,#8B5E3C); border-radius:50%;
  animation:bwSpin .7s linear infinite;
}
@keyframes bwSpin { to { transform:rotate(360deg); } }

/* Mobile ≤ 600px */
@media (max-width:600px) {
  .bw-sl-grid   { grid-template-columns:repeat(2,1fr); }
  .bw-type-row  { grid-template-columns:1fr; }
  .bw-form-row  { grid-template-columns:1fr; }
  .bw-pay-row   { grid-template-columns:1fr; }
  .bw-cal-grid  { gap:2px; }
  .bw-dc        { font-size:13px; }
  .bw-month-lbl { font-size:17px; }
}
`
    document.head.appendChild(s)
  }

  // ── Init on DOM ready ─────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
