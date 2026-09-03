import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * 骨架组合模式（09-frontend.md §3）：layouts/*Grid.tsx 由 tangle 生成、禁止手改，
 * 业务组件经本 Portal 挂入骨架的 data-region 锚点容器。
 * 骨架重渲染/区域切换（如宫格 ↔ 单图）后自动重新定位宿主。
 */
export function RegionPortal({
  root,
  region,
  children,
}: {
  root: RefObject<HTMLElement | null>;
  region: string;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(`[data-region="${region}"]`) ?? null;
    if (el !== host) setHost(el);
  });
  return host ? createPortal(children, host) : null;
}
