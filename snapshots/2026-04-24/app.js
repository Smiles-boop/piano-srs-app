// PianoSRS — main app entry point.
//
// This file is deliberately small. Features are layered in across the roadmap
// (see ROADMAP.md). Today it just wires up the shell: sets a status message
// and hooks up the (currently disabled) "Add piece" button so we have an
// obvious place to graft PDF upload onto in the next roadmap step.

const APP_VERSION = '0.1.0';

const els = {
  status: document.getElementById('app-status'),
  addPieceBtn: document.getElementById('add-piece-btn'),
  pieceList: document.getElementById('piece-list'),
  viewerPlaceholder: document.getElementById('viewer-placeholder'),
};

/** Set the small status line in the footer. */
export function setStatus(message) {
  if (els.status) {
    els.status.textContent = message;
  }
}

/**
 * Render the piece list. Today this just shows an empty-state row because
 * nothing is persisted yet. Roadmap items 2 and 3 will replace this with
 * actual uploaded pieces from IndexedDB.
 *
 * @param {Array<{id: string, title: string}>} pieces
 */
export function renderPieceList(pieces) {
  if (!els.pieceList) return;
  els.pieceList.innerHTML = '';
  if (!pieces || pieces.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'piece-list-empty';
    empty.textContent = 'No pieces yet. PDF upload arrives in the next step.';
    els.pieceList.appendChild(empty);
    return;
  }
  for (const piece of pieces) {
    const li = document.createElement('li');
    li.className = 'piece-list-item';
    li.dataset.pieceId = piece.id;
    li.textContent = piece.title;
    els.pieceList.appendChild(li);
  }
}

function init() {
  setStatus(`Ready · v${APP_VERSION}`);
  // Placeholder for step 2 — the button is disabled for now, but reserve the
  // click handler so the upload flow has a single known entry point.
  if (els.addPieceBtn) {
    els.addPieceBtn.addEventListener('click', () => {
      setStatus('PDF upload is coming in the next roadmap step.');
    });
  }
  renderPieceList([]);
}

document.addEventListener('DOMContentLoaded', init);
