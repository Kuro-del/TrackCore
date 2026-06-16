(function () {
  const LOGIN_PAGE = '/login.html';

  function injectStyles() {
    if (document.getElementById('trackcoreAuthWidgetStyles')) return;

    const style = document.createElement('style');
    style.id = 'trackcoreAuthWidgetStyles';

    style.textContent = `
      .trackcore-user-widget {
        position: relative !important;
        display: inline-flex !important;
        align-items: center !important;
        z-index: 99999 !important;
        margin-left: 0.5rem !important;
      }

      .trackcore-user-widget.trackcore-fixed {
        position: fixed !important;
        top: 0.75rem !important;
        right: 1.25rem !important;
      }

      .trackcore-user-button {
        appearance: none !important;
        border: 1px solid rgba(255, 255, 255, 0.35) !important;
        background: rgba(255, 255, 255, 0.18) !important;
        color: #ffffff !important;
        border-radius: 999px !important;
        padding: 0.35rem 0.65rem 0.35rem 0.35rem !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 0.55rem !important;
        cursor: pointer !important;
        font-family: "Segoe UI", system-ui, Arial, sans-serif !important;
        font-size: 0.9rem !important;
        min-height: 42px !important;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.16) !important;
      }

      .trackcore-user-button:hover {
        background: rgba(255, 255, 255, 0.28) !important;
      }

      .trackcore-user-avatar {
        width: 34px !important;
        height: 34px !important;
        border-radius: 999px !important;
        display: inline-grid !important;
        place-items: center !important;
        background: #0e9b97 !important;
        color: #ffffff !important;
        font-size: 0.78rem !important;
        font-weight: 900 !important;
        overflow: hidden !important;
        flex: 0 0 auto !important;
      }

      .trackcore-user-avatar img {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover !important;
      }

      .trackcore-user-info {
        display: flex !important;
        flex-direction: column !important;
        align-items: flex-start !important;
        gap: 0.15rem !important;
        line-height: 1.1 !important;
      }

      .trackcore-user-info strong {
        color: #ffffff !important;
        font-size: 0.86rem !important;
        max-width: 150px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }

      .trackcore-user-info small {
        color: rgba(255, 255, 255, 0.75) !important;
        font-size: 0.68rem !important;
        text-transform: uppercase !important;
        letter-spacing: 0.06em !important;
        font-weight: 800 !important;
      }

      .trackcore-user-chevron {
        color: rgba(255, 255, 255, 0.85) !important;
        font-size: 0.78rem !important;
      }

      .trackcore-user-menu {
        position: absolute !important;
        top: calc(100% + 0.55rem) !important;
        right: 0 !important;
        z-index: 100000 !important;
        min-width: 230px !important;
        padding: 0.55rem !important;
        border-radius: 15px !important;
        border: 1px solid #d8c7d5 !important;
        background: #f9f4f9 !important;
        color: #2f2430 !important;
        box-shadow: 0 18px 40px rgba(67, 34, 60, 0.22) !important;
      }

      .trackcore-user-menu[hidden] {
        display: none !important;
      }

      .trackcore-user-menu-header {
        padding: 0.7rem 0.75rem !important;
        border-bottom: 1px solid #d8c7d5 !important;
        margin-bottom: 0.45rem !important;
      }

      .trackcore-user-menu-header strong {
        display: block !important;
        color: #2f2430 !important;
        font-size: 0.92rem !important;
        margin-bottom: 0.15rem !important;
      }

      .trackcore-user-menu-header span {
        display: block !important;
        color: #6f6270 !important;
        font-size: 0.8rem !important;
      }

      .trackcore-user-menu-item {
        width: 100% !important;
        appearance: none !important;
        border: none !important;
        background: transparent !important;
        color: #b34a52 !important;
        padding: 0.75rem !important;
        border-radius: 11px !important;
        cursor: pointer !important;
        text-align: left !important;
        font-family: "Segoe UI", system-ui, Arial, sans-serif !important;
        font-size: 0.88rem !important;
        font-weight: 800 !important;
      }

      .trackcore-user-menu-item:hover {
        background: #fdecee !important;
      }

      @media (max-width: 640px) {
        .trackcore-user-info {
          display: none !important;
        }

        .trackcore-user-button {
          padding-right: 0.45rem !important;
        }

        .trackcore-user-widget.trackcore-fixed {
          right: 0.75rem !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function getInitials(value) {
    const name = String(value || '').trim();
    if (!name) return 'U';

    const parts = name.split(/\s+/).filter(Boolean);

    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function buildWidget(user, fixed = false) {
    const widget = document.createElement('div');
    widget.className = fixed
      ? 'trackcore-user-widget trackcore-fixed'
      : 'trackcore-user-widget';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trackcore-user-button';

    const avatar = document.createElement('span');
    avatar.className = 'trackcore-user-avatar';

    if (user.fotoUrl) {
      const img = document.createElement('img');
      img.src = user.fotoUrl;
      img.alt = user.nombre || user.usuario || 'Usuario';
      avatar.appendChild(img);
    } else {
      avatar.textContent = getInitials(user.nombre || user.usuario);
    }

    const info = document.createElement('span');
    info.className = 'trackcore-user-info';

    const name = document.createElement('strong');
    name.textContent = user.nombre || user.usuario || 'Usuario';

    const role = document.createElement('small');
    role.textContent = user.rol || 'usuario';

    info.appendChild(name);
    info.appendChild(role);

    const chevron = document.createElement('span');
    chevron.className = 'trackcore-user-chevron';
    chevron.textContent = '▾';

    button.appendChild(avatar);
    button.appendChild(info);
    button.appendChild(chevron);

    const menu = document.createElement('div');
    menu.className = 'trackcore-user-menu';
    menu.hidden = true;

    const menuHeader = document.createElement('div');
    menuHeader.className = 'trackcore-user-menu-header';

    const menuName = document.createElement('strong');
    menuName.textContent = user.nombre || 'Usuario';

    const menuUser = document.createElement('span');
    menuUser.textContent = '@' + (user.usuario || 'usuario');

    menuHeader.appendChild(menuName);
    menuHeader.appendChild(menuUser);

    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.className = 'trackcore-user-menu-item';
    logoutButton.textContent = 'Cerrar sesión';

    logoutButton.addEventListener('click', async () => {
      logoutButton.disabled = true;
      logoutButton.textContent = 'Cerrando sesión...';

      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include'
        });
      } catch (error) {
        console.error(error);
      }

      window.location.href = LOGIN_PAGE;
    });

    menu.appendChild(menuHeader);
    menu.appendChild(logoutButton);

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    menu.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    document.addEventListener('click', () => {
      menu.hidden = true;
    });

    widget.appendChild(button);
    widget.appendChild(menu);

    return widget;
  }

  function insertWidget(user) {
    const oldWidget = document.querySelector('.trackcore-user-widget');

    if (oldWidget) {
      oldWidget.remove();
    }

    const appbar = document.querySelector('.appbar');

    if (appbar) {
      let actions = appbar.querySelector('.actions');

      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'actions';
        appbar.appendChild(actions);
      }

      actions.style.display = 'flex';
      actions.style.alignItems = 'center';
      actions.style.gap = '0.45rem';

      actions.appendChild(buildWidget(user, false));
      return;
    }

    document.body.appendChild(buildWidget(user, true));
  }

  async function init() {
    if (window.location.pathname.endsWith('/login.html')) {
      return;
    }

    injectStyles();

    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include'
      });

      const data = await response.json();

      console.log('TrackCore Auth /api/auth/me:', data);

      if (!data.authenticated) {
        window.location.href = LOGIN_PAGE;
        return;
      }

      insertWidget(data.user);

      console.log('TrackCore Auth: widget insertado.');
    } catch (error) {
      console.error('TrackCore Auth error:', error);
      window.location.href = LOGIN_PAGE;
    }
  }

  window.addEventListener('load', init);
})();