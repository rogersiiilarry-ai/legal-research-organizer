import { deriveReaderTask } from "./readerTasks";

export function attachReaderTasks(findings: any[]) {
  return findings.map(f => {
    const task = deriveReaderTask(f);
    return task ? { ...f, readerTask: task } : f;
  });
}
