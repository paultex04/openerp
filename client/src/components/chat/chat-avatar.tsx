'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { avatarImageUrl, avatarTint, initials } from '@/lib/avatar';
import { cn } from '@/lib/utils';

/**
 * A person's avatar, used by the chat list, the message thread and the account
 * directory.
 *
 * Extracted so the three agree: the same initials, the same stable tint, and the
 * same "no image means initials" fallback. `avatarTint` is seeded with the email
 * (falling back to the name) because that is the stable identifier; two people
 * called "John S" would otherwise share a colour.
 */
export function ChatAvatar({
  name,
  email,
  avatarUpdatedAt,
  className,
}: {
  name: string;
  email?: string;
  /** Cache-buster; undefined renders the initials fallback. */
  avatarUpdatedAt?: string | null;
  className?: string;
}) {
  const src = avatarImageUrl(avatarUpdatedAt);
  return (
    <Avatar className={cn('size-8 shrink-0', className)}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback className={cn('text-[11px] font-semibold', avatarTint(email ?? name))}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
