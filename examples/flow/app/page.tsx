import { PipelineEditor } from "../components/PipelineEditor";
import { pipeline } from "../server/pipeline";

// The first frame shows the pipeline as the Server keeps it; the run follows live.
export default function PipelinePage() {
  return <PipelineEditor initial={pipeline.snapshot()} run={pipeline.currentRun()} />;
}
