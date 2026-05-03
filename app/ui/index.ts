// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Barrel — re-exports all Phase-1 atom primitives so consumers can write:
//   import { Button, Input, Badge, Loader, Text } from "~/ui";

export {
  Button,
  LinkButton,
  RefreshButton,
  buttonVariants,
  KUMO_BUTTON_VARIANTS,
  KUMO_BUTTON_DEFAULT_VARIANTS,
} from "./button";
export type {
  ButtonProps,
  LinkButtonProps,
  KumoButtonShape,
  KumoButtonSize,
  KumoButtonVariant,
  KumoButtonVariantsProps,
} from "./button";

export {
  Input,
  inputVariants,
  KUMO_INPUT_VARIANTS,
  KUMO_INPUT_DEFAULT_VARIANTS,
} from "./input";
export type {
  InputProps,
  KumoInputSize,
  KumoInputVariant,
  KumoInputVariantsProps,
  FieldErrorMatch,
} from "./input";

export {
  Badge,
  badgeVariants,
  KUMO_BADGE_BASE_STYLES,
  KUMO_BADGE_VARIANTS,
  KUMO_BADGE_DEFAULT_VARIANTS,
} from "./badge";
export type {
  BadgeProps,
  BadgeVariant,
  KumoBadgeVariant,
  KumoBadgeVariantsProps,
} from "./badge";

export {
  Loader,
  loaderVariants,
  KUMO_LOADER_VARIANTS,
  KUMO_LOADER_DEFAULT_VARIANTS,
} from "./loader";
export type {
  LoaderProps,
  KumoLoaderSize,
  KumoLoaderVariantsProps,
} from "./loader";

export {
  Text,
  textVariants,
  KUMO_TEXT_VARIANTS,
  KUMO_TEXT_DEFAULT_VARIANTS,
} from "./text";
export type {
  TextProps,
  KumoTextVariant,
  KumoTextSize,
  KumoTextVariantsProps,
} from "./text";

export {
  Tooltip,
  TooltipProvider,
  tooltipVariants,
  KUMO_TOOLTIP_VARIANTS,
  KUMO_TOOLTIP_DEFAULT_VARIANTS,
} from "./tooltip";
export type {
  TooltipProps,
  KumoTooltipSide,
  KumoTooltipVariantsProps,
} from "./tooltip";

export {
  Toasty,
  ToastProvider,
  useToastManager,
  toastVariants,
  KUMO_TOAST_VARIANTS,
  KUMO_TOAST_DEFAULT_VARIANTS,
} from "./toast";
export type {
  ToastyProps,
  ToastData,
  KumoToastVariant,
  KumoToastVariantsProps,
} from "./toast";

export {
  Dialog,
  DialogRoot,
  DialogTrigger,
  DialogTitle,
  DialogDescription,
  DialogClose,
  dialogVariants,
  KUMO_DIALOG_VARIANTS,
  KUMO_DIALOG_DEFAULT_VARIANTS,
} from "./dialog";
export type {
  DialogProps,
  DialogRootProps,
  DialogTriggerProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
  KumoDialogSize,
  KumoDialogRole,
  KumoDialogVariantsProps,
} from "./dialog";
