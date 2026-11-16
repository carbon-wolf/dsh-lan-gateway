/* Gateway mobile runtime.
 *
 * Responsibilities:
 *   1. mark the document for the mobile CSS layer and expose a real viewport unit;
 *   2. mount the settings + lock controls INSIDE the composer's left action slot
 *      (`conversation.input.left`), so they sit with the other input controls
 *      instead of floating over the page — with a floating fallback when that
 *      slot is not on screen.
 * It never restructures the React tree and every failure is swallowed.
 */
(() => {
  const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.4"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.2" r="1.15" fill="currentColor" stroke="none"/></svg>'
  const GEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.67 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03Z"/></svg>'

  const SLOT_SELECTORS = [
    '[data-slot="conversation.input.left"]',
    '[data-slot="conversation.composer.bar"]',
  ]

  const CONTROL_STYLE = `
    :host { all: initial; display: inline-flex; align-items: center; gap: 2px; }
    button {
      display: grid;
      place-items: center;
      padding: 0;
      margin: 0;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      -webkit-tap-highlight-color: transparent;
      opacity: 0.62;
      transition: opacity 0.15s ease, transform 0.15s ease;
    }
    button:hover, button:focus-visible { opacity: 1 }
    button:active { transform: scale(0.92) }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 8px }
    svg { width: 18px; height: 18px; display: block }

    /* Inside the composer action row: match the neighbouring icon buttons. */
    :host([data-placement='slot']) button { width: 30px; height: 30px; border-radius: 8px; }

    /* Nowhere to dock: keep them reachable but out of the composer's way. */
    :host([data-placement='float']) {
      position: fixed;
      right: max(10px, env(safe-area-inset-right, 0px));
      bottom: calc(88px + env(safe-area-inset-bottom, 0px));
      gap: 6px;
      padding: 3px 5px;
      border-radius: 999px;
      border: 1px solid rgb(255 255 255 / 0.16);
      background: rgb(20 22 28 / 0.72);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 4px 14px rgb(0 0 0 / 0.35);
      z-index: 2147483000;
    }
    :host([data-placement='float']) button { width: 32px; height: 32px; border-radius: 50%; }

    /* Wide screens use the sidebar account menu entries instead of inline icons. */
    @media (min-width: 901px) { :host { display: none; } }
  `

  let control = null
  let timer = null

  const build = () => {
    const host = document.createElement('div')
    host.id = 'dshgw-lock'
    host.setAttribute('data-dsh-gateway', 'controls')
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CONTROL_STYLE

    const settings = document.createElement('button')
    settings.type = 'button'
    settings.title = '网关设置'
    settings.setAttribute('aria-label', '打开网关设置')
    settings.innerHTML = GEAR_ICON
    settings.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      window.location.href = '/_gw/settings'
    })

    const lock = document.createElement('button')
    lock.type = 'button'
    lock.title = '锁定 / 退出网关'
    lock.setAttribute('aria-label', '锁定并退出网关')
    lock.innerHTML = LOCK_ICON
    lock.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!window.confirm('锁定并退出？再次进入需要输入网关密码。')) return
      void (async () => {
        try {
          await fetch('/_gw/lock', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        } catch {
          // even if the call fails, fall through to the login page
        }
        window.location.replace('/_gw/login')
      })()
    })

    shadow.append(style, settings, lock)
    return host
  }

  const place = () => {
    if (control === null) return
    const slot = SLOT_SELECTORS.map((selector) => document.querySelector(selector)).find((element) => element !== null) ?? null
    if (slot !== null) {
      if (control.parentElement !== slot) {
        slot.appendChild(control)
        control.dataset.placement = 'slot'
      }
      return
    }
    if (control.parentElement !== document.documentElement) {
      document.documentElement.appendChild(control)
    }
    control.dataset.placement = 'float'
  }

  const keepAlive = () => {
    // React may replace the slot's children on re-render; re-dock when dropped.
    if (control !== null && !control.isConnected) place()
  }

  /**
   * Add 网关设置 / 锁定网关 to the sidebar account menu (设置 · 意见反馈 · 退出登录).
   * Items are cloned from the existing ones so the look matches the app theme,
   * and the injected nodes are tagged so a re-render creates them once.
   */
  const decorateMenu = () => {
    const menu = document.querySelector('[role="menu"][data-anchor-side]')
    if (menu === null || menu.querySelector('[data-dshgw-item]') !== null) return
    const viewport = menu.querySelector('[role="presentation"]')
    if (viewport === null) return
    const wraps = [...viewport.children].filter((element) => element.querySelector('button[role="menuitem"]') !== null)
    const findWrap = (label) => wraps.find((wrap) => (wrap.textContent ?? '').includes(label))
    const settingsWrap = findWrap('设置')
    const logoutWrap = findWrap('退出登录')
    if (settingsWrap === undefined || logoutWrap === undefined) return

    const cloneItem = (template, label, originalLabel, iconSource, handler) => {
      const wrap = template.cloneNode(true)
      wrap.setAttribute('data-dshgw-item', '1')
      const button = wrap.querySelector('button[role="menuitem"]')
      if (button === null) return null
      button.removeAttribute('aria-keyshortcuts')
      button.setAttribute('type', 'button')

      // Locate the label text node (the template's own label), then rename it.
      const textNodes = []
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) textNodes.push(node)
      const labelNode = textNodes.find((node) => (node.nodeValue ?? '').trim() === originalLabel)
        ?? textNodes.find((node) => (node.nodeValue ?? '').trim() !== '')
        ?? null
      if (labelNode === null) button.append(document.createTextNode(label))
      else labelNode.nodeValue = label

      // Drop everything else the template carried (keyboard shortcut, badges),
      // keeping only the icon and the label.
      const iconHolder = button.querySelector('svg')?.parentElement ?? button.querySelector('svg')
      const labelHolder = labelNode?.parentElement ?? null
      for (const child of [...button.childNodes]) {
        if (child === labelNode || child === labelHolder) continue
        if (iconHolder !== null && (child === iconHolder || (child.nodeType === 1 && child.contains(iconHolder)))) continue
        child.remove()
      }

      const sourceIcon = iconSource?.querySelector('svg') ?? null
      const targetIcon = button.querySelector('svg')
      if (sourceIcon !== null && targetIcon !== null) targetIcon.replaceWith(sourceIcon.cloneNode(true))

      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        handler()
      }, { capture: true })
      return wrap
    }

    const settingsItem = cloneItem(settingsWrap, '网关设置', '设置', settingsWrap, () => {
      window.location.href = '/_gw/settings'
    })
    const lockItem = cloneItem(logoutWrap, '锁定网关', '退出登录', logoutWrap, () => {
      if (!window.confirm('锁定并退出？再次进入需要输入网关密码。')) return
      void (async () => {
        try {
          await fetch('/_gw/lock', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        } catch {
          // even if the call fails, fall through to the login page
        }
        window.location.replace('/_gw/login')
      })()
    })
    if (settingsItem === null || lockItem === null) return
    logoutWrap.before(settingsItem, lockItem)
  }

  const mount = () => {
    if (document.getElementById('dshgw-lock') !== null) {
      control = document.getElementById('dshgw-lock')
      place()
      return
    }
    control = build()
    document.documentElement.appendChild(control)
    control.dataset.placement = 'float'
    place()
    // The shell mounts asynchronously: retry early, then settle into a slow poll.
    for (const delay of [0, 300, 900, 1800, 3200]) setTimeout(place, delay)
    if (timer === null) {
      timer = window.setInterval(() => {
        keepAlive()
        place()
        decorateMenu()
      }, 2000)
    }
    try {
      new MutationObserver(() => {
        keepAlive()
        decorateMenu()
      }).observe(document.documentElement, { childList: true, subtree: true })
    } catch {
      // observer is best-effort
    }
  }

  const start = () => {
    try {
      const root = document.documentElement
      const coarse = window.matchMedia('(pointer: coarse)').matches
      const apply = () => {
        const narrow = window.innerWidth <= 900
        const mobile = narrow || coarse
        if (mobile) root.setAttribute('data-dsh-mobile', '')
        else root.removeAttribute('data-dsh-mobile')
        root.style.setProperty('--dsh-mobile-vh', `${window.innerHeight * 0.01}px`)
      }
      apply()
      window.addEventListener('resize', apply, { passive: true })
      window.visualViewport?.addEventListener('resize', apply, { passive: true })
      window.addEventListener('orientationchange', apply, { passive: true })

      mount()
    } catch (error) {
      console.warn('[dshgw] mobile layer failed', error)
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
