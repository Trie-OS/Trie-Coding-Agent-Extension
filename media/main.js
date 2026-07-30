// @ts-check
;(function () {
  const vscode = acquireVsCodeApi()

  const messagesEl = /** @type {HTMLElement} */ (document.getElementById('messages'))
  const todosEl = /** @type {HTMLElement} */ (document.getElementById('todos'))
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'))
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'))
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stop-btn'))
  const newBtn = /** @type {HTMLButtonElement} */ (document.getElementById('new-btn'))
  const connectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('connect-btn'))
  const backendChip = /** @type {HTMLElement} */ (document.getElementById('backend-chip'))
  const hybridChip = /** @type {HTMLElement} */ (document.getElementById('hybrid-chip'))

  /** @type {Map<number, HTMLElement>} */
  const toolCards = new Map()
  let spinnerEl = /** @type {HTMLElement | null} */ (null)

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  /**
   * @param {string} className
   * @param {string} text
   */
  function addBubble(className, text) {
    const el = document.createElement('div')
    el.className = 'bubble ' + className
    el.textContent = text
    messagesEl.appendChild(el)
    scrollDown()
    return el
  }

  function showSpinner() {
    hideSpinner()
    spinnerEl = document.createElement('div')
    spinnerEl.className = 'spinner-row'
    spinnerEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>'
    messagesEl.appendChild(spinnerEl)
    scrollDown()
  }

  function hideSpinner() {
    spinnerEl?.remove()
    spinnerEl = null
  }

  function send() {
    const text = inputEl.value.trim()
    if (!text) return
    addBubble('user', text)
    inputEl.value = ''
    showSpinner()
    vscode.postMessage({ type: 'send', text })
  }

  sendBtn.addEventListener('click', send)
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
  newBtn.addEventListener('click', () => vscode.postMessage({ type: 'new' }))
  connectBtn.addEventListener('click', () => vscode.postMessage({ type: 'connect' }))

  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'state': {
        backendChip.textContent = msg.model
        backendChip.title = msg.backend
        hybridChip.hidden = !msg.hybrid
        sendBtn.disabled = msg.busy
        stopBtn.hidden = !msg.busy
        if (!msg.busy) hideSpinner()
        break
      }
      case 'tool-call': {
        hideSpinner()
        const card = document.createElement('div')
        card.className = 'tool-card running'
        const head = document.createElement('div')
        head.className = 'tool-head'
        head.innerHTML =
          '<span class="tool-status">·</span> <span class="tool-name"></span> <span class="tool-args"></span>'
        head.querySelector('.tool-name').textContent = msg.tool
        head.querySelector('.tool-args').textContent = msg.args
        card.appendChild(head)
        if (msg.thought) {
          const thought = document.createElement('div')
          thought.className = 'tool-thought'
          thought.textContent = msg.thought
          card.appendChild(thought)
        }
        messagesEl.appendChild(card)
        toolCards.set(msg.id, card)
        showSpinner()
        scrollDown()
        break
      }
      case 'tool-result': {
        const card = toolCards.get(msg.id)
        if (!card) break
        card.classList.remove('running')
        card.classList.add(msg.ok ? 'ok' : 'failed')
        const status = card.querySelector('.tool-status')
        if (status) status.textContent = msg.ok ? '✓' : '✗'
        const args = card.querySelector('.tool-args')
        if (args && msg.summary) args.textContent = msg.summary
        break
      }
      case 'todos': {
        todosEl.hidden = msg.todo.length === 0 && msg.done.length === 0
        todosEl.innerHTML = ''
        const title = document.createElement('div')
        title.className = 'todos-title'
        title.textContent = 'Todos'
        todosEl.appendChild(title)
        for (const item of msg.done) {
          const row = document.createElement('div')
          row.className = 'todo done'
          row.textContent = '☑ ' + item
          todosEl.appendChild(row)
        }
        for (const item of msg.todo) {
          const row = document.createElement('div')
          row.className = 'todo'
          row.textContent = '☐ ' + item
          todosEl.appendChild(row)
        }
        break
      }
      case 'guide': {
        hideSpinner()
        const el = document.createElement('div')
        el.className = 'guide ' + (msg.verdict === 'looks_good' ? 'good' : 'concern')
        const label = document.createElement('div')
        label.className = 'guide-label'
        label.textContent =
          'Hybrid guide · ' + (msg.checkpoint === 'stuck_hint' ? 'stuck hint' : 'final review')
        const body = document.createElement('div')
        body.textContent = msg.text
        el.appendChild(label)
        el.appendChild(body)
        messagesEl.appendChild(el)
        showSpinner()
        scrollDown()
        break
      }
      case 'final': {
        hideSpinner()
        addBubble(msg.ok ? 'assistant' : 'assistant failed', msg.text)
        break
      }
      case 'error': {
        hideSpinner()
        addBubble('error', msg.text)
        break
      }
      case 'reset': {
        messagesEl.innerHTML = ''
        todosEl.innerHTML = ''
        todosEl.hidden = true
        toolCards.clear()
        hideSpinner()
        break
      }
    }
  })
})()
