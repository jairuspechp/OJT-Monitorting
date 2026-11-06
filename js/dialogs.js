/*
 * dialogs.js
 *
 * The pop-up windows: "Create new layout" and the Are-you-sure confirmation. (The Add/Edit link dialog is in link-slots.js,
 * the shortcut list is in shortcuts.js.)
 */
(function () {
  const LG = window.LinkGrid;
  const { state, storage, expandedByBoard, ui } = LG;
  const topbarEl = document.getElementById('topbar');
  const contentEl = document.getElementById('content');

  // In-app confirmation dialog, styled the same as the settings/notify
  // modals used elsewhere (add link, grid setting) instead of the
  // browser's native window.confirm() popup.
  function openConfirmDialog({ title, message, confirmLabel }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'settings-backdrop';
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(false);
      });

      const modal = document.createElement('div');
      modal.className = 'settings-modal';

      const heading = document.createElement('h3');
      heading.textContent = title || 'Are you sure?';
      modal.appendChild(heading);

      const body = document.createElement('div');
      body.className = 'settings-message';
      body.textContent = message || '';
      modal.appendChild(body);

      const row = document.createElement('div');
      row.className = 'settings-row-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => finish(false));
      row.appendChild(cancelBtn);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'danger';
      confirmBtn.textContent = confirmLabel || 'Confirm';
      confirmBtn.addEventListener('click', () => finish(true));
      row.appendChild(confirmBtn);

      modal.appendChild(row);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      confirmBtn.focus();

      document.addEventListener('keydown', onKeydown);

      function onKeydown(event) {
        if (event.key === 'Escape') finish(false);
      }

      function finish(result) {
        document.removeEventListener('keydown', onKeydown);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        resolve(result);
      }
    });
  }

  // Remove a whole layout (asks first). Used by the layouts page and the menu.
  async function confirmRemoveBoard(board) {
    const links = board.slots.filter(Boolean).length;
    const confirmed = await openConfirmDialog({
      title: 'Remove layout?',
      message: '"' + board.name + '" will be removed' +
        (links ? ' together with its ' + links + ' link' + (links === 1 ? '' : 's') : '') +
        '. This cannot be undone.',
      confirmLabel: 'Remove',
    });
    if (!confirmed) return false;
    storage.deleteBoard(board);
    LG.showHint('Layout removed');
    return true;
  }

  // New layouts always start with 4 link placeholders (one page).
  // More are added with "Add slot" in the layout's toolbar.
  function openNewGridDialog() {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Create new layout';
    modal.appendChild(heading);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'settings-field-label';
    nameLabel.textContent = 'Layout name';
    modal.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Layout ' + (state.boards.length + 1);
    nameInput.value = 'Layout ' + (state.boards.length + 1);
    modal.appendChild(nameInput);

    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = 'Starts with 4 link slots. Use "Add slot" in the toolbar to add more.';
    modal.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    row.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'save';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', () => {
      const name = nameInput.value.trim() || 'Layout ' + (state.boards.length + 1);
      storage.createBoard(name, LG.SLOTS_PER_PAGE, 'standard').then((id) => {
        close();
        if (id) LG.openBoard(id);
      });
    });
    row.appendChild(createBtn);

    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createBtn.click();
      if (event.key === 'Escape') close();
    });

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    nameInput.focus();
    nameInput.select();

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }


Object.assign(LG, {
    openConfirmDialog,
    openNewGridDialog,
    confirmRemoveBoard,
  });
})();