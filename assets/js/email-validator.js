// email-validator.js — shared email validation utilities

function isValidEmail(email) {
  const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/
  if (!re.test(email)) return false
  const domain = email.split('@')[1]
  return domain != null && domain.includes('.')
}

function showEmailError(inputEl, message) {
  clearEmailError(inputEl)
  const err = document.createElement('p')
  err.className = 'email-validator-err'
  err.style.cssText = 'color:#C0392B;font-size:12px;margin-top:4px;margin-bottom:0'
  err.textContent = message
  inputEl.parentNode.insertBefore(err, inputEl.nextSibling)
  inputEl.style.borderColor = '#C0392B'
}

function clearEmailError(inputEl) {
  const existing = inputEl.parentNode.querySelector('.email-validator-err')
  if (existing) existing.remove()
  inputEl.style.borderColor = ''
}
