//! The question when the window closes and a note could not be saved (M3-016). The
//! page shows it in Liurium's own dialog, so closing is a question and an answer: Rust
//! stops the close, the page picks the question up through a waiting call, and only
//! while a question waits can an answer close the window or drop text.

use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use super::{CommandError, Workspace, projects::blocking};

/// A waiting page asks again after this long, so a reloaded page leaves nothing behind.
const WAIT_AT_MOST: Duration = Duration::from_secs(30);

/// Why the note could not be saved while closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CloseReason.ts"))]
pub enum CloseReason {
    ChangedOutside,
    DeletedOutside,
    NotWritten,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CloseQuestion.ts"))]
pub struct CloseQuestion {
    /// The note's file name.
    pub name: String,
    pub reason: CloseReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CloseChoice.ts"))]
pub enum CloseChoice {
    /// Not an answer: the page shows the question, so it is alive and the user decides.
    Shown,
    KeepBoth,
    Discard,
    Stay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS), ts(export_to = "CloseOutcome.ts"))]
pub enum CloseOutcome {
    /// The window stays; also when no question was waiting.
    Stays,
    /// The window closes.
    Closes,
    /// The copy could not be written; the window stays so nothing is lost.
    CopyFailed,
}

#[derive(Default)]
struct Asked {
    question: Option<CloseQuestion>,
    /// Counts questions, so a late timer cannot act on a newer one.
    count: u64,
    /// A waiting call has returned it.
    delivered: bool,
    /// The page confirmed that it shows it.
    shown: bool,
}

#[derive(Clone, Default)]
pub struct CloseQuestions {
    shared: Arc<(Mutex<Asked>, Condvar)>,
}

impl CloseQuestions {
    fn lock(&self) -> Result<MutexGuard<'_, Asked>, CommandError> {
        self.shared.0.lock().map_err(|_| CommandError::Internal)
    }

    /// Puts a question up, also when one is open: closing again must show that the page
    /// is still alive. Returns its number for `take_unshown`.
    pub fn ask(&self, question: CloseQuestion) -> u64 {
        let (lock, asked) = &*self.shared;
        let Ok(mut state) = lock.lock() else {
            return 0;
        };
        state.question = Some(question);
        state.count += 1;
        state.delivered = false;
        state.shown = false;
        let count = state.count;
        drop(state);
        asked.notify_all();
        count
    }

    /// The question once one waits to be delivered, or `None` after `at_most`.
    pub(super) fn wait(&self, at_most: Duration) -> Result<Option<CloseQuestion>, CommandError> {
        let (lock, asked) = &*self.shared;
        let state = lock.lock().map_err(|_| CommandError::Internal)?;
        let (mut state, _) = asked
            .wait_timeout_while(state, at_most, |state| {
                state.question.is_none() || state.delivered
            })
            .map_err(|_| CommandError::Internal)?;
        if state.delivered {
            return Ok(None);
        }
        state.delivered = state.question.is_some();
        Ok(state.question.clone())
    }

    /// Whether question number `count` was not shown, removing it if so. A page that
    /// stopped answering must not keep the window from closing.
    pub fn take_unshown(&self, count: u64) -> bool {
        self.lock().is_ok_and(|mut state| {
            let unshown = state.count == count && state.question.is_some() && !state.shown;
            if unshown {
                state.question = None;
            }
            unshown
        })
    }

    fn take(&self) -> Result<Option<CloseQuestion>, CommandError> {
        Ok(self.lock()?.question.take())
    }
}

impl Workspace {
    /// The user's answer. Without a waiting question it does nothing, so a stray call can
    /// neither close the window nor drop text.
    pub fn answer_close_question(&self, choice: CloseChoice) -> Result<CloseOutcome, CommandError> {
        let questions = self.close_questions();
        if choice == CloseChoice::Shown {
            let mut state = questions.lock()?;
            state.shown = state.question.is_some();
            return Ok(CloseOutcome::Stays);
        }
        if questions.take()?.is_none() {
            return Ok(CloseOutcome::Stays);
        }
        Ok(match choice {
            CloseChoice::KeepBoth if !self.editor().keep_both_before_close() => {
                CloseOutcome::CopyFailed
            }
            CloseChoice::KeepBoth => CloseOutcome::Closes,
            CloseChoice::Discard => {
                self.editor().discard();
                CloseOutcome::Closes
            }
            CloseChoice::Stay | CloseChoice::Shown => CloseOutcome::Stays,
        })
    }
}

/// Waits until a question waits, or 30 seconds passed.
#[tauri::command]
pub async fn wait_close_question(
    workspace: State<'_, Workspace>,
) -> Result<Option<CloseQuestion>, CommandError> {
    let questions = workspace.close_questions().clone();
    blocking(move || questions.wait(WAIT_AT_MOST)).await
}

#[tauri::command]
pub async fn answer_close_question(
    choice: CloseChoice,
    window: WebviewWindow,
    workspace: State<'_, Workspace>,
) -> Result<CloseOutcome, CommandError> {
    let workspace = workspace.inner().clone();
    let outcome = blocking(move || workspace.answer_close_question(choice)).await?;
    if outcome == CloseOutcome::Closes {
        // Not `close`: that would ask again. The answer has been acted on.
        window.destroy().map_err(|_| CommandError::Internal)?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question() -> CloseQuestion {
        CloseQuestion {
            name: "Plan.md".to_owned(),
            reason: CloseReason::ChangedOutside,
        }
    }

    const NOW: Duration = Duration::ZERO;

    #[test]
    fn a_question_is_delivered_once_and_again_after_closing_again() {
        let questions = CloseQuestions::default();
        assert_eq!(questions.wait(NOW).ok(), Some(None));

        questions.ask(question());
        assert_eq!(questions.wait(NOW).ok(), Some(Some(question())));
        assert_eq!(questions.wait(NOW).ok(), Some(None));

        questions.ask(question());
        assert_eq!(questions.wait(NOW).ok(), Some(Some(question())));
    }

    #[test]
    fn a_waiting_page_gets_the_question_when_it_comes() {
        let questions = CloseQuestions::default();
        let other = questions.clone();
        let waiting = std::thread::spawn(move || other.wait(Duration::from_secs(60)).ok());
        std::thread::sleep(Duration::from_millis(50));

        questions.ask(question());

        assert_eq!(waiting.join().expect("joined"), Some(Some(question())));
    }

    #[test]
    fn delivered_is_not_shown_because_a_frozen_page_can_still_get_the_answer() {
        let questions = CloseQuestions::default();
        let count = questions.ask(question());
        assert_eq!(questions.wait(NOW).ok(), Some(Some(question())));

        assert!(questions.take_unshown(count));
        assert!(!questions.take_unshown(count));
    }

    #[test]
    fn an_older_timer_does_not_take_a_newer_question() {
        let questions = CloseQuestions::default();
        let first = questions.ask(question());
        let second = questions.ask(question());

        assert!(!questions.take_unshown(first));
        assert!(questions.take_unshown(second));
    }
}
