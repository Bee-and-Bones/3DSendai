// U9 (plan-004) — pending-approval queue for the device. Pure C (no libctru),
// host-KAT'd by client/test/approvalq_test.c; the overlay render (ui.c) and
// the A/B response wiring (main.c) are the hardware-only layer.
//
// Multiple pending approvals queue FIFO; the head is what the top-screen
// overlay shows and what A/B answer. When the queue is full the push is
// refused — the host's approval timeout denies the overflow safely (U10).
#ifndef SENDAI_APPROVAL_H
#define SENDAI_APPROVAL_H

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define AB_APPROVALQ_CAP 4

typedef struct {
  uint32_t session_id;
  char id[40];     // approvalId (host-minted, echoed back verbatim)
  char tool[24];   // e.g. "Bash"
  char detail[96]; // human-readable summary
  char risk[8];    // "low" / "high"
} ab_approval;

typedef struct {
  ab_approval q[AB_APPROVALQ_CAP];
  int count;
  int head; // index of the OLDEST (currently shown) entry
} ab_approvalq;

static inline void ab_approvalq_init(ab_approvalq *q) {
  q->count = 0;
  q->head = 0;
}

static inline int ab_approvalq_count(const ab_approvalq *q) { return q->count; }

// Copy bounded fields into the tail slot. False when full (caller reports;
// the host denies unanswered approvals by timeout).
static inline bool ab_approvalq_push(ab_approvalq *q, uint32_t session_id, const char *id,
                                     const char *tool, const char *detail, const char *risk) {
  if (q->count >= AB_APPROVALQ_CAP) return false;
  ab_approval *a = &q->q[(q->head + q->count) % AB_APPROVALQ_CAP];
  a->session_id = session_id;
  snprintf(a->id, sizeof a->id, "%s", id ? id : "");
  snprintf(a->tool, sizeof a->tool, "%s", tool ? tool : "");
  snprintf(a->detail, sizeof a->detail, "%s", detail ? detail : "");
  snprintf(a->risk, sizeof a->risk, "%s", risk ? risk : "");
  q->count++;
  return true;
}

// The approval the overlay currently shows; NULL when none pending.
static inline const ab_approval *ab_approvalq_head(const ab_approvalq *q) {
  return q->count > 0 ? &q->q[q->head] : (const ab_approval *)0;
}

// Discard the head (after its APPROVAL_RESPONSE was sent).
static inline void ab_approvalq_pop(ab_approvalq *q) {
  if (q->count == 0) return;
  q->head = (q->head + 1) % AB_APPROVALQ_CAP;
  q->count--;
}

#endif // SENDAI_APPROVAL_H
