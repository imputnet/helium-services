document.documentElement.classList.add('js');

document.addEventListener('change', (event) => {
    const form = event.target.closest?.('form.filters');

    if (form) {
        form.requestSubmit();
    }
});
