function renderNav(activePage) {
  const tnav = [
    { key: 'npcs',        href: '/npcs.html',        label: 'NPCs'    },
    { key: 'items',       href: '/items.html',        label: 'Items'   },
    { key: 'quests',      href: '/quests.html',       label: 'Quests'  },
    { key: 'loot',        href: '/loot.html',         label: 'Loot'    },
    { key: 'vendors',     href: '/vendors.html',      label: 'Vendors' },
    { key: 'talents',     href: '/talents.html',      label: 'Talents' },
    { key: 'raid-timers', href: '/raid-timers.html',  label: 'Timers'  },
  ];

  const mnav = [
    { key: 'home',        href: '/',                  label: 'Home'             },
    { key: 'npcs',        href: '/npcs.html',         label: 'NPCs &amp; Mobs'  },
    { key: 'items',       href: '/items.html',        label: 'Items'            },
    { key: 'quests',      href: '/quests.html',       label: 'Quests'           },
    { key: 'loot',        href: '/loot.html',         label: 'Loot Tables'      },
    { key: 'vendors',     href: '/vendors.html',      label: 'Vendors'          },
    { key: 'talents',     href: '/talents.html',      label: 'Talent Calculator'},
    { key: 'raid-timers', href: '/raid-timers.html',  label: 'Raid Timers'      },
  ];

  const tnavHTML = tnav.map(({ key, href, label }) =>
    `<a class="tnav-btn${activePage === key ? ' active' : ''}" href="${href}">${label}</a>`
  ).join('\n    ');

  const mnavHTML = mnav.map(({ key, href, label }) =>
    `<a class="mnav-tab${activePage === key ? ' active' : ''}" href="${href}">${label}</a>`
  ).join('\n  ');

  const html = `<div id="topbar">
  <a class="logo" href="/"><div class="logo-icon"><img src="/images/Logo/Logo.png" alt="EpochDB Logo" style="width:100%;height:100%;object-fit:contain;"/></div></a>
  <div id="topnav">
    ${tnavHTML}
  </div>
</div>
<div id="mainnav">
  ${mnavHTML}
</div>`;

  const root = document.getElementById('nav-root');
  root.outerHTML = html;
}
