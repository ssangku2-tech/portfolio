// 지에프아이 알림 정시 실행용 Cloudflare Worker (무료 플랜의 Cron Trigger 사용)
// 매일 09:00 KST에 GitHub Actions 워크플로(gfi-alert.yml)를 workflow_dispatch로 실행시킨다.
// 실제 수집·전송은 GitHub Actions가 하고, 이 Worker는 "정시 알람" 역할만 한다.
// GitHub 자체 예약 실행은 백업으로 남아 있고, 같은 날 중복 전송은 스크립트가 막는다.
//
// 필요한 Worker 비밀값: GITHUB_TOKEN (이 저장소에 Actions: Read and write 권한만 준 fine-grained 토큰)

const REPO = 'ssangku2-tech/portfolio';
const WORKFLOW = 'gfi-alert.yml';

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gfi-cron-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main', inputs: { scheduled: 'true' } }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch 실패 ${res.status}: ${await res.text()}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};
