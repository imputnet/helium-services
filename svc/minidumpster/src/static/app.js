// deno-lint-ignore-file

document.addEventListener('submit', (event) => {
    const message = event.target.dataset.confirm;
    if (message && !globalThis.confirm(message)) {
        event.preventDefault();
    }
});

document.addEventListener('change', (event) => {
    if (event.target.matches('[data-chart-breakdown]')) {
        event.target.form.requestSubmit();
    }
});

document.addEventListener('click', (event) => {
    if (event.target.matches('[data-stack-fold-toggle]')) {
        const foldToggle = event.target;
        const id = foldToggle.dataset.stackFoldToggle;
        const expanded = foldToggle.getAttribute('aria-expanded') === 'true';
        foldToggle.setAttribute('aria-expanded', String(!expanded));
        document.querySelectorAll('[data-stack-fold-row]').forEach((row) => {
            if (row.dataset.stackFoldRow === id) {
                row.hidden = expanded;
            }
        });
        return;
    }

    if (event.target.matches('[data-copy-report]')) {
        const copy = event.target;
        fetch(document.location.href, {
            headers: { accept: 'text/plain' },
        }).then((response) => {
            if (!response.ok) {
                throw new Error(`copy source failed: ${response.status}`);
            }
            return response.text();
        }).then((text) => navigator.clipboard.writeText(text)).then(() => {
            const original = copy.textContent;
            copy.textContent = 'Copied';
            setTimeout(() => {
                copy.textContent = original;
            }, 1200);
        });
        return;
    }

    const target = event.target.closest('.expandable');
    if (!target) {
        return;
    }
    const full = target.dataset.full;
    target.dataset.full = target.textContent;
    target.textContent = full;
});
