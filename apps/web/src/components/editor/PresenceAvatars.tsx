"use client";

import { cn } from "@/lib/utils/cn";
import type { PresenceUser } from "@backslash/shared";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

// ─── Types ──────────────────────────────────────────

interface PresenceAvatarsProps {
  users: PresenceUser[];
  currentUserId: string;
  maxVisible?: number;
}

// ─── PresenceAvatars ────────────────────────────────

export function PresenceAvatars({
  users,
  currentUserId,
  maxVisible = 5,
}: PresenceAvatarsProps) {
  // Filter out current user, show others
  const others = users.filter((u) => u.userId !== currentUserId);

  if (others.length === 0) return null;

  const visible = others.slice(0, maxVisible);
  const overflow = others.length - maxVisible;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex items-center -space-x-1.5">
        {visible.map((user) => (
          <Tooltip key={user.userId}>
            <TooltipTrigger asChild>
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg-primary text-[11px] font-semibold cursor-default transition-transform hover:scale-110 hover:z-10"
                style={{ backgroundColor: user.color, color: "#1e1e2e" }}
              >
                {user.name.charAt(0).toUpperCase()}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                <p className="font-medium">{user.name}</p>
                {user.activeFilePath && (
                  <p className="text-text-muted mt-0.5">
                    Viewing {user.activeFilePath}
                  </p>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}

        {overflow > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg-primary bg-bg-elevated text-[10px] font-semibold text-text-secondary cursor-default">
                +{overflow}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-xs">
                {others.slice(maxVisible).map((u) => (
                  <p key={u.userId}>{u.name}</p>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
