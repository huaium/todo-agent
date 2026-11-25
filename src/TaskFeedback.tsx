import { useEffect, useState } from "react";

export interface TaskNotice {
  text: string;
}

export function TaskFeedback({ notice }: { notice?: TaskNotice }) {
  const [dismissed, setDismissed] = useState<TaskNotice>();
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setDismissed(notice), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <div className="completion-status" role="status" aria-atomic="true">
      {notice && (
        <span key={notice.text} data-dismissed={dismissed === notice || undefined}>
          {notice.text}
        </span>
      )}
    </div>
  );
}
