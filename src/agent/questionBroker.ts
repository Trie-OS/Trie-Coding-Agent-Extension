/**
 * In-chat question broker — resolves ask_user_question via the webview instead of modals.
 */

export interface QuestionOption {
  label: string
}

export interface UserQuestionPayload {
  question: string
  options: string[]
  multiSelect?: boolean
}

export interface QuestionAnswer {
  question: string
  answer: string
  isOther?: boolean
}

export type QuestionRequestHandler = (
  requestId: string,
  questions: UserQuestionPayload[],
) => Promise<QuestionAnswer[] | null>

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000

export class QuestionBroker {
  private handler: QuestionRequestHandler | null = null

  setHandler(handler: QuestionRequestHandler | null): void {
    this.handler = handler
  }

  async ask(questions: UserQuestionPayload[]): Promise<QuestionAnswer[] | null> {
    if (!this.handler) return null
    const requestId = crypto.randomUUID()
    return new Promise<QuestionAnswer[] | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Question request timed out after 5 minutes without an answer.'))
      }, QUESTION_TIMEOUT_MS)
      this.handler!(requestId, questions).then(
        (answers) => {
          clearTimeout(timer)
          resolve(answers)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}
