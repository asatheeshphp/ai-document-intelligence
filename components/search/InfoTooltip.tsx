interface InfoTooltipProps {
  text: string;
}

// Custom popover, not the native browser `title` attribute — styled consistently with
// the rest of the UI instead of the OS's plain tooltip box.
export function InfoTooltip({ text }: InfoTooltipProps) {
  return (
    <span className="group relative inline-flex cursor-help align-middle">
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] font-semibold leading-none text-zinc-400 ring-1 ring-inset ring-zinc-300 dark:text-zinc-500 dark:ring-zinc-600"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 w-52 -translate-x-1/2 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 dark:bg-zinc-700"
      >
        {text}
      </span>
    </span>
  );
}
