/* Gateway injection layer.
 *
 * Two jobs only:
 *   1. mark the document for the mobile CSS layer and expose a real viewport unit;
 *   2. add 网关设置 / 锁定网关 to the sidebar account menu (设置 · 意见反馈 · 退出登录).
 *
 * The entries are cloned from the native items so the icon, font and spacing
 * match the app theme. Nothing is rendered inline in the composer: on a phone
 * the sidebar can be expanded with the header button, which is where the
 * account menu lives. Failures are swallowed so the app keeps working.
 */
(() => {
  /**
   * Add the two items to the account menu. Injected nodes are tagged, so a
   * re-render produces them once; closing the menu drops them with it.
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

      // Rename the template's own label, then drop everything else it carried
      // (keyboard shortcut, badges) while keeping the icon and the label.
      const textNodes = []
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) textNodes.push(node)
      const labelNode = textNodes.find((node) => (node.nodeValue ?? '').trim() === originalLabel)
        ?? textNodes.find((node) => (node.nodeValue ?? '').trim() !== '')
        ?? null
      if (labelNode === null) button.append(document.createTextNode(label))
      else labelNode.nodeValue = label

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

      decorateMenu()
      window.setInterval(decorateMenu, 2000)
      try {
        new MutationObserver(() => decorateMenu()).observe(document.documentElement, { childList: true, subtree: true })
      } catch {
        // observer is best-effort
      }
    } catch (error) {
      console.warn('[dshgw] injection failed', error)
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
