//! Delivery pacing only. Local commits and their signatures remain durable immediately.
use std::time::Duration;
use tokio::time::Instant;

const QUIET: Duration = Duration::from_millis(500);
const MAX_WAIT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct SendSchedule {
    observed: Option<i64>,
    released: i64,
    first: Option<Instant>,
    last: Option<Instant>,
    force: bool,
}
impl SendSchedule {
    pub fn observe(&mut self, now: Instant, sequence: i64) -> i64 {
        if self.observed.is_none() || self.force {
            self.observed = Some(sequence);
            self.released = sequence;
            self.first = None;
            self.last = None;
            self.force = false;
            return sequence;
        }
        if sequence > self.observed.unwrap() {
            self.first.get_or_insert(now);
            self.last = Some(now);
            self.observed = Some(sequence);
        }
        if self
            .first
            .is_some_and(|at| now.duration_since(at) >= MAX_WAIT)
            || self.last.is_some_and(|at| now.duration_since(at) >= QUIET)
        {
            self.released = self.observed.unwrap();
            self.first = None;
            self.last = None;
        }
        self.released
    }
    pub fn release_all(&mut self) {
        self.force = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn releases_at_quiet_boundary_and_never_delays_continuous_input_past_two_seconds() {
        let mut schedule = SendSchedule::default();
        let start = Instant::now();
        assert_eq!(schedule.observe(start, 10), 10);
        assert_eq!(schedule.observe(start, 11), 10);
        assert_eq!(schedule.observe(start + Duration::from_millis(400), 12), 10);
        assert_eq!(schedule.observe(start + Duration::from_millis(899), 12), 10);
        assert_eq!(schedule.observe(start + Duration::from_millis(900), 12), 12);
        for i in 0..20 {
            assert_eq!(
                schedule.observe(start + Duration::from_millis(1000 + i * 100), 13 + i as i64),
                12
            );
        }
        assert_eq!(
            schedule.observe(start + Duration::from_millis(3000), 33),
            33
        );
    }
    #[test]
    fn reconnect_flushes_saved_work_without_changing_future_edit_windows() {
        let mut schedule = SendSchedule::default();
        let start = Instant::now();
        assert_eq!(schedule.observe(start, 100), 100);
        assert_eq!(schedule.observe(start, 101), 100);
        schedule.release_all();
        assert_eq!(schedule.observe(start, 102), 102);
        assert_eq!(schedule.observe(start, 103), 102);
        assert_eq!(schedule.observe(start + QUIET, 103), 103);
    }
}
