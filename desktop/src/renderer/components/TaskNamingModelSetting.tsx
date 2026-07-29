import {
  isTextGenerationModel,
  TEXT_GENERATION_MODELS,
  type TextGenerationModel,
} from "@hitch/shared/taskTitles";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LABELS: Record<TextGenerationModel, string> = {
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

export function TaskNamingModelSetting({
  value,
  onChange,
}: {
  value: TextGenerationModel;
  onChange: (model: TextGenerationModel) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Task naming model</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Runs locally through your Codex or Claude subscription.
        </p>
      </div>
      <Select
        value={value}
        onValueChange={(next) => {
          if (isTextGenerationModel(next)) onChange(next);
        }}
      >
        <SelectTrigger
          aria-label="Task naming model"
          className="w-48 shrink-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TEXT_GENERATION_MODELS.map((model) => (
            <SelectItem key={model} value={model}>
              {LABELS[model]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
