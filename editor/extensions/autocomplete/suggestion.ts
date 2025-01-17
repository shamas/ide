import { Editor, Range } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'

import type { ResultType } from 'editor/referenceType'

export interface SuggestionOptions<Item = ResultType> {
  editor: Editor,
  char?: string,
  startOfLine?: boolean,
  decorationTag?: string,
  decorationClass?: string,
  command?: (props: {
    editor: Editor,
    range: Range,
    props: Item,
  }) => void,
  items?: ((query: string) => Item[]) | ((query: string) => Promise<Item[]>),
  render?: () => {
    onStart?: (props: SuggestionProps<Item>) => void,
    onUpdate?: (props: SuggestionProps<Item>) => void,
    onExit?: (props: SuggestionProps<Item>) => void,
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean,
  },
  allow?: (props: {
    editor: Editor,
    range: Range,
  }) => boolean,
}

export interface SuggestionProps<Item = ResultType> {
  editor: Editor
  range: Range
  query: string
  text: string
  items: Item[]
  command: (props: Item) => void
  decorationNode: Element | null
  clientRect: (() => DOMRect) | null
}

export interface SuggestionKeyDownProps {
  view: EditorView
  event: KeyboardEvent
  range: Range
}

interface SuggestionPluginState {
  active: boolean
  range?: {
    from: number
    to: number
  }
  decorationID?: string
  query: string | null
  text: string | null
  wasCharTyped: boolean
}

export function Suggestion<Item = ResultType>({
  editor,
  char = '/',
  startOfLine = false,
  decorationTag = 'span',
  decorationClass = 'suggestion',
  command = () => null,
  items = () => [],
  render = () => ({}),
  allow = () => true,
}: SuggestionOptions<Item>) {
  const renderer = render?.()

  const allowSpaces = false

  return new Plugin<SuggestionPluginState>({
    key: new PluginKey('suggestion'),

    view() {
      return {
        update: async (view, prevState) => {
          const prev = this.key?.getState(prevState)
          const next = this.key?.getState(view.state)

          // See how the state changed
          const moved = prev.active && next.active && prev.range.from !== next.range.from
          const started = !prev.active && next.active
          const stopped = prev.active && !next.active
          const changed = !started && !stopped && prev.query !== next.query
          const handleStart = started || moved
          const handleChange = changed && !moved
          const handleExit = stopped || moved

          // Cancel when suggestion isn't active
          if (!handleStart && !handleChange && !handleExit) {
            return
          }

          const state = handleExit && !handleStart
            ? prev
            : next
          const decorationNode = document.querySelector(`[data-decoration-id="${state.decorationId}"]`)
          const props: SuggestionProps<Item> = {
            editor,
            range: state.range,
            query: state.query,
            text: state.text,
            items: (handleChange || handleStart)
              ? await items(state.query)
              : [],
            command: commandProps => command({
              editor,
              range: state.range,
              props: commandProps,
            }),
            decorationNode,
            // virtual node for popper.js or tippy.js
            // this can be used for building popups without a DOM node
            clientRect: decorationNode
              ? () => decorationNode.getBoundingClientRect()
              : null,
          }

          if (handleExit) {
            renderer?.onExit?.(props)
          }

          if (handleChange) {
            renderer?.onUpdate?.(props)
          }

          if (handleStart) {
            renderer?.onStart?.(props)
          }
        },
      }
    },

    state: {
      // Initialize the plugin's internal state.
      init() {
        return {
          active: false,
          query: null,
          text: null,
          wasCharTyped: false,
        }
      },

      // Apply changes to the plugin state from a view transaction.
      apply(transaction, prev) {
        const { selection } = transaction
        const next = { ...prev }


        // We can only be suggesting if there is no selection
        if (!prev.wasCharTyped) {
          next.active = false
        } else if (selection.from === selection.to) {
          // Reset active state if we just left the previous suggestion range
          if (prev.range && (selection.from < prev.range?.from || selection.from > prev.range?.to)) {
            next.active = false
          }

          const $position = selection.$from

          const isTopLevelNode = $position.depth <= 0
          const textFrom = isTopLevelNode
            ? 0
            : $position.before()

          const textTo = $position.pos
          const text = $position.doc.textBetween(textFrom, textTo, '\0', '\0')

          if (text) {
            const lastWord = /(\S+)$/
            const prefixWord = lastWord.exec(text)
            if (prefixWord) {
              const match = prefixWord[0]
              const range = {
                from: textFrom + text.length - match.length + 1,
                to: textFrom + text.length + 1,
              }

              if (allow({ editor, range })) {
                const decorationID = `id_${Math.floor(Math.random() * 0xFFFFFFFF)}`
                next.active = true
                next.decorationID = prev.decorationID ? prev.decorationID : decorationID
                next.range = range
                next.text = match
                next.query = match
              } else {
                next.active = false
              }
            } else {
              next.active = false
            }
          }
        } else {
          next.active = false
        }

        // Make sure to empty the range if suggestion is inactive
        if (!next.active) {
          next.wasCharTyped = false
          next.decorationID = undefined
          next.range = undefined
          next.query = null
          next.text = null
        }

        return next
      },
    },

    props: {
      handleTextInput(view, from, to, text) {
        const state = this.getState(view.state)
        if (!state) return

        if (text) {
          state.wasCharTyped = true
        }

        return false
      },
      // Call the keydown hook if suggestion is active.
      handleKeyDown(view, event) {
        const state = this.getState(view.state)
        if (!state) return

        const { active, range } = state

        if (!active) {
          return false
        }

        if (!range) {
          return false
        }

        return renderer?.onKeyDown?.({ view, event, range }) || false
      },

      // Setup decorator on the currently active suggestion.
      decorations(state) {
        const { active, range, decorationID } = this.getState(state) as SuggestionPluginState

        if (!range) {
          return null
        }

        if (!active) {
          return null
        }

        return DecorationSet.create(state.doc, [
          Decoration.inline(range.from, range.to, {
            nodeName: decorationTag,
            class: decorationClass,
            'data-decoration-id': decorationID,
          }),
        ])
      },
    },
  })
}
