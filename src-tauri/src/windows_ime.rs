//! Control the focused WebView2 input thread through its default IME window.
//! Do not obtain a foreign-thread HIMC and mutate it on the Tokio worker.
//! https://learn.microsoft.com/windows/win32/api/imm/nf-imm-immgetdefaultimewnd

use crate::InputMethodDeactivation;

trait ImeWindows {
    fn focused_input(&self, owner: usize) -> Result<usize, &'static str>;
    fn ime_window(&self, input: usize) -> Result<usize, &'static str>;
    fn open_status(&self, ime: usize) -> Result<bool, &'static str>;
    fn close(&self, ime: usize) -> Result<(), &'static str>;
}

fn deactivate_with(api: &impl ImeWindows, owner: usize) -> InputMethodDeactivation {
    let run = || {
        let input = api.focused_input(owner)?;
        let ime = api.ime_window(input)?;
        if !api.open_status(ime)? {
            return Ok("windows-ime-already-inactive");
        }
        // IPC and message delivery are asynchronous. Never target another
        // application's IME if focus changed while the request was queued.
        if api.focused_input(owner)? != input || api.ime_window(input)? != ime {
            return Err("windows-ime-focus-changed");
        }
        api.close(ime)?;
        if api.focused_input(owner)? != input {
            return Err("windows-ime-focus-changed");
        }
        if api.open_status(ime)? {
            return Err("windows-ime-deactivation-refused");
        }
        Ok("windows-ime-inactive")
    };
    match run() {
        Ok(detail) => InputMethodDeactivation {
            supported: true,
            inactive: true,
            detail: detail.into(),
        },
        Err(detail) => InputMethodDeactivation {
            supported: true,
            inactive: false,
            detail: detail.into(),
        },
    }
}

#[cfg(any(target_os = "windows", feature = "windows-clipboard-contract"))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn deactivate(owner: usize) -> InputMethodDeactivation {
    deactivate_with(&native::NativeImeWindows, owner)
}

#[cfg(any(target_os = "windows", feature = "windows-clipboard-contract"))]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod native {
    use super::ImeWindows;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::Ime::{IMC_SETOPENSTATUS, ImmGetDefaultIMEWnd};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GUITHREADINFO, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsChild,
        SMTO_ABORTIFHUNG, SMTO_BLOCK, SMTO_ERRORONEXIT, SendMessageTimeoutW, WM_IME_CONTROL,
    };

    pub(super) struct NativeImeWindows;

    // The IME-window protocol includes this query, but windows-sys only
    // exports IMC_SETOPENSTATUS. Keep the missing protocol constant local.
    const IMC_GETOPENSTATUS: u32 = 0x0005;

    fn control(ime: usize, command: u32, value: isize) -> Result<usize, &'static str> {
        let mut result = 0;
        let delivered = unsafe {
            SendMessageTimeoutW(
                ime as HWND,
                WM_IME_CONTROL,
                command as usize,
                value,
                SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
                250,
                &mut result,
            )
        };
        // A zero message RESULT means closed/success. A zero API return means
        // failure/timeout and must never be misreported as IME already OFF.
        if delivered == 0 {
            Err("windows-ime-message-failed-or-timed-out")
        } else {
            Ok(result)
        }
    }

    impl ImeWindows for NativeImeWindows {
        fn focused_input(&self, owner: usize) -> Result<usize, &'static str> {
            let owner = owner as HWND;
            if owner.is_null() || unsafe { GetForegroundWindow() } != owner {
                return Err("windows-ime-owner-not-foreground");
            }
            let mut process = 0;
            let thread = unsafe { GetWindowThreadProcessId(owner, &mut process) };
            if thread == 0 || process != std::process::id() {
                return Err("windows-ime-owner-unavailable");
            }
            let mut gui = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if unsafe { GetGUIThreadInfo(thread, &mut gui) } == 0 || gui.hwndFocus.is_null() {
                return Err("windows-ime-no-focused-input");
            }
            if gui.hwndFocus != owner && unsafe { IsChild(owner, gui.hwndFocus) } == 0 {
                return Err("windows-ime-focus-outside-owner");
            }
            Ok(gui.hwndFocus as usize)
        }

        fn ime_window(&self, input: usize) -> Result<usize, &'static str> {
            let ime = unsafe { ImmGetDefaultIMEWnd(input as HWND) };
            if ime.is_null() {
                Err("windows-ime-no-default-window")
            } else {
                Ok(ime as usize)
            }
        }

        fn open_status(&self, ime: usize) -> Result<bool, &'static str> {
            control(ime, IMC_GETOPENSTATUS, 0).map(|value| value != 0)
        }

        fn close(&self, ime: usize) -> Result<(), &'static str> {
            match control(ime, IMC_SETOPENSTATUS, 0)? {
                0 => Ok(()),
                _ => Err("windows-ime-deactivation-refused"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        open: Cell<bool>,
        closes: Cell<usize>,
        focus_calls: Cell<usize>,
        change_focus_at: usize,
        fail_read: bool,
        refuse_close: bool,
        targets: RefCell<Vec<usize>>,
    }
    impl Default for Fake {
        fn default() -> Self {
            Self {
                open: Cell::new(true),
                closes: Cell::new(0),
                focus_calls: Cell::new(0),
                change_focus_at: usize::MAX,
                fail_read: false,
                refuse_close: false,
                targets: RefCell::new(vec![]),
            }
        }
    }
    impl ImeWindows for Fake {
        fn focused_input(&self, owner: usize) -> Result<usize, &'static str> {
            assert_eq!(owner, 1);
            let call = self.focus_calls.get();
            self.focus_calls.set(call + 1);
            if call >= self.change_focus_at {
                Err("windows-ime-owner-not-foreground")
            } else {
                Ok(2)
            }
        }
        fn ime_window(&self, input: usize) -> Result<usize, &'static str> {
            assert_eq!(input, 2);
            Ok(3)
        }
        fn open_status(&self, ime: usize) -> Result<bool, &'static str> {
            self.targets.borrow_mut().push(ime);
            if self.fail_read {
                Err("windows-ime-message-failed-or-timed-out")
            } else {
                Ok(self.open.get())
            }
        }
        fn close(&self, ime: usize) -> Result<(), &'static str> {
            self.targets.borrow_mut().push(ime);
            self.closes.set(self.closes.get() + 1);
            if !self.refuse_close {
                self.open.set(false);
            }
            Ok(())
        }
    }

    #[test]
    fn closes_the_focused_childs_ime_and_verifies_the_result() {
        let api = Fake::default();
        let result = deactivate_with(&api, 1);
        assert!(result.inactive);
        assert_eq!(result.detail, "windows-ime-inactive");
        assert_eq!(api.closes.get(), 1);
        assert_eq!(*api.targets.borrow(), [3, 3, 3]);
    }

    #[test]
    fn does_not_notify_an_already_closed_ime() {
        let api = Fake {
            open: Cell::new(false),
            ..Default::default()
        };
        assert!(deactivate_with(&api, 1).inactive);
        assert_eq!(api.closes.get(), 0);
    }

    #[test]
    fn never_targets_another_foreground_application() {
        for change_focus_at in [0, 1] {
            let api = Fake {
                change_focus_at,
                ..Default::default()
            };
            assert!(!deactivate_with(&api, 1).inactive);
            assert_eq!(api.closes.get(), 0);
        }
    }

    #[test]
    fn does_not_report_timeouts_or_ignored_close_as_success() {
        let timeout = Fake {
            fail_read: true,
            ..Default::default()
        };
        assert!(!deactivate_with(&timeout, 1).inactive);
        assert_eq!(timeout.closes.get(), 0);
        let ignored = Fake {
            refuse_close: true,
            ..Default::default()
        };
        assert!(!deactivate_with(&ignored, 1).inactive);
    }
}
